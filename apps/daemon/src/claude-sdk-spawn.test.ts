import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { query, type SDKUserMessage, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import type { Runtime } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ClaudeAgentSdkAdapter } from "./claude.js"
import { claudeKeeperSource, type ClaudeSpawn } from "./claude-process.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { fakeClaudeChild } from "./test-claude-process.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

// Domovoi starts the Claude process itself, through spawnClaudeCodeProcess, so
// that a stop can wait for it and kill its process group (issue #646). What
// the SDK's own spawn did is copied into claude-process.ts. These tests read
// the installed SDK, so an upgrade that changes that spawn, or what the SDK
// hands a custom spawner, fails here until the copy is checked again.

const sdkDirectory = join(
  dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@anthropic-ai", "claude-agent-sdk",
)
const runtime: Runtime = {
  provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false,
}
const scratchDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await removeScratchDirectories(scratchDirectories.splice(0))
})

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-claude-sdk-spawn-"))
  scratchDirectories.push(directory)
  return directory
}

async function* noMessages(): AsyncGenerator<SDKUserMessage> {}

describe("the SDK spawn Domovoi copies", () => {
  it("is the one in the SDK release Domovoi was checked against", async () => {
    const manifest = JSON.parse(await readFile(join(sdkDirectory, "package.json"), "utf8")) as { version: string }
    expect(manifest.version).toBe("0.3.263")

    const source = await readFile(join(sdkDirectory, "sdk.mjs"), "utf8")
    const start = source.indexOf("spawnLocalProcess(")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf("initialize(){", start))
    const name = String.raw`[\w$]+`
    // spawn(command, args, { cwd, stdio: pipes, signal, env, windowsHide: true })
    expect(body).toMatch(new RegExp(
      String.raw`^spawnLocalProcess\((${name})\)\{let\{command:(${name}),args:(${name}),cwd:(${name}),env:(${name}),signal:(${name})\}=\1,${name}=${name}\(\2,\3,\{cwd:\4,stdio:\["pipe","pipe","pipe"\],signal:\6,env:\5,windowsHide:!0\}\)`,
    ))
    // stderr decoded as UTF-8 and handed to the stderr option.
    expect(body).toMatch(new RegExp(String.raw`new ${name}\("utf8"\)`))
    expect(body).toContain("this.options.stderr?.(")
  })

  it("hands a custom spawner exactly the command, arguments, directory, environment and signal", async () => {
    const directory = await scratch()
    const spawned: SpawnOptions[] = []
    const fake = fakeClaudeChild()
    const running = query({
      prompt: noMessages(),
      options: {
        cwd: directory,
        pathToClaudeCodeExecutable: join(directory, "claude"),
        spawnClaudeCodeProcess: (options) => {
          spawned.push(options)
          return fake.process
        },
      },
    })
    running.close()

    expect(spawned).toHaveLength(1)
    expect(Object.keys(spawned[0]!).sort()).toEqual(["args", "command", "cwd", "env", "signal"])
    await waitForDaemon(() => expect(fake.child.exitCode).toBe(0))
  })

  it("reaches Domovoi's spawner from the default query factory, and ends its stdin on close", async () => {
    const directory = await scratch()
    const executable = join(directory, process.platform === "win32" ? "claude.exe" : "claude")
    // Found on PATH, never run: the spawn below is a double.
    await writeFile(executable, "#!/bin/sh\nexit 1\n")
    await chmod(executable, 0o755)
    vi.stubEnv("PATH", directory)
    // The SDK builds the environment from this process's and names itself
    // as the entry point unless one is set already.
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", undefined)
    vi.stubEnv("DOMOVOI_CLAUDE_SPAWN_MARKER", "inherited")
    const fake = fakeClaudeChild()
    const spawn = vi.fn<ClaudeSpawn>(() => fake.process)
    const adapter = new ClaudeAgentSdkAdapter(undefined, undefined, async () => {}, {
      spawn, platform: "linux",
    })

    const starting = adapter.startThread({ cwd: directory, runtime }).then(
      () => undefined,
      (error: unknown) => error,
    )
    await waitForDaemon(() => expect(spawn).toHaveBeenCalledOnce())
    // On POSIX Domovoi starts the keeper that leads Claude's process group,
    // with Claude's directory and abort signal and an empty environment, and
    // hands it the command, arguments and environment the SDK built. The fifth
    // pipe goes to the sentinel the keeper starts in the group (R3-F2).
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual(["-e", claudeKeeperSource])
    expect(options.cwd).toBe(directory)
    expect(options.env).toEqual({})
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], windowsHide: true, detached: true })
    const claude = fake.commands[0]?.spawn as { command: string; args: string[]; env: NodeJS.ProcessEnv }
    expect(claude.command).toBe(executable)
    expect(claude.args.slice(0, 5)).toEqual(["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"])
    expect(claude.env.DOMOVOI_CLAUDE_SPAWN_MARKER).toBe("inherited")
    expect(claude.env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts")

    // The SDK's close ends stdin and Claude exits on that. Q104: the keeper
    // kills the process group it leaves as it exits, and nothing, no signal
    // and no kill, is sent to Claude or its keeper.
    await adapter.close()
    expect(fake.child.exitCode).toBe(0)
    expect(fake.child.kill).not.toHaveBeenCalled()
    expect(fake.commands.slice(1)).toEqual([])
    await starting
  })

  // Slice P6b, through the installed SDK: a trusted repository's settings
  // reach Claude as its --settings flag and its servers as an mcp_set_servers
  // request once Claude has listed the person's own, each exactly as the plan
  // took them from the digested documents.
  it("hands Claude a trusted repository's loadable settings and servers as digested, and nothing held back", async () => {
    const directory = await scratch()
    const executable = join(directory, process.platform === "win32" ? "claude.exe" : "claude")
    await writeFile(executable, "#!/bin/sh\nexit 1\n")
    await chmod(executable, 0o755)
    vi.stubEnv("PATH", directory)
    const worktree = join(directory, "worktree")
    await mkdir(join(worktree, ".claude"), { recursive: true })
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "./bootstrap.sh" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./held-back-allow.sh" }] }],
      },
      env: { NODE_ENV: "development", NODE_OPTIONS: "--require ./held-back.js" },
      permissions: { deny: ["Read(./.env)"], allow: ["Bash(held-back-allow)"] },
      apiKeyHelper: "./held-back-key.sh",
    }
    const servers = { mcpServers: {
      db: { command: "db-mcp", env: { DATABASE_URL: "postgres://db" } },
      mine: { command: "held-back-shadow" },
    } }
    await writeFile(join(worktree, ".claude", "settings.json"), JSON.stringify(settings))
    await writeFile(join(worktree, ".mcp.json"), JSON.stringify(servers))
    const { configDigest } = await readRepositoryProviderConfig(worktree, { heldBack: true })
    const repositoryTrust = { projectId: "project-acme", trustedDigest: configDigest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" as const } }

    // Claude's side of the SDK's control channel: each request is answered
    // as Claude answers it, and the person already has a server named "mine".
    const fake = fakeClaudeChild()
    const requests: Array<Record<string, unknown>> = []
    let buffered = ""
    fake.child.stdin.on("data", (chunk: Buffer) => {
      buffered += String(chunk)
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, newline)) as { type?: string; request_id?: string; request?: Record<string, unknown> }
        buffered = buffered.slice(newline + 1)
        if (message.type !== "control_request" || !message.request) continue
        requests.push(message.request)
        const response = message.request.subtype === "mcp_status" ? { mcpServers: [{ name: "mine", status: "connected" }] }
          : message.request.subtype === "mcp_set_servers" ? { added: ["db"], removed: [], errors: {} }
            : {}
        fake.child.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } })}\n`)
      }
    })
    const spawn = vi.fn<ClaudeSpawn>(() => fake.process)
    const adapter = new ClaudeAgentSdkAdapter(undefined, undefined, async () => {}, { spawn, platform: "linux" })

    await adapter.startThread({ cwd: worktree, runtime, repositoryTrust })
    await waitForDaemon(() => expect(requests.map(({ subtype }) => subtype)).toContain("mcp_set_servers"))

    const loadedSettings = {
      hooks: { SessionStart: settings.hooks.SessionStart },
      env: { NODE_ENV: "development" },
      permissions: { deny: settings.permissions.deny },
    }
    const claude = fake.commands[0]?.spawn as { args: string[] }
    const flag = claude.args.indexOf("--settings")
    expect(flag).toBeGreaterThan(-1)
    expect(claude.args[flag + 1]).toBe(JSON.stringify(loadedSettings))
    expect(claude.args).toContain("--setting-sources=user")
    expect(claude.args).not.toContain("--mcp-config")
    expect(claude.args).not.toContain("--strict-mcp-config")
    expect(requests.map(({ subtype }) => subtype)).toEqual(["initialize", "mcp_status", "mcp_set_servers"])
    expect(JSON.stringify(requests[2]!.servers)).toBe(JSON.stringify({ db: servers.mcpServers.db }))
    const reached = JSON.stringify([claude.args, requests])
    for (const text of ["held-back", "NODE_OPTIONS", "apiKeyHelper"]) expect(reached, text).not.toContain(text)

    await adapter.close()
  })
})
