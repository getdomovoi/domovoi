import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import { CodexAppServerAdapter, type CodexTransport, type JsonRpcMessage } from "./codex.js"

class RecordingTransport implements CodexTransport {
  readonly sent: JsonRpcMessage[] = []
  #listener: ((message: JsonRpcMessage) => void) | undefined

  send(message: JsonRpcMessage): void {
    this.sent.push(message)
    const id = message.id
    if (id !== undefined) queueMicrotask(() => this.#listener?.({ id, result: {} }))
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listener = listener
    return () => { this.#listener = undefined }
  }

  onError(): () => void {
    return () => {}
  }

  async close(): Promise<void> {}
}

const runtime: Runtime = { provider: "codex", model: "gpt-5.3-codex", reasoning: "high", permissionMode: "build", auto: false }

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function repository(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "domovoi-codex-config-")))
  directories.push(root)
  execFileSync("git", ["init", "-q", root])
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

async function connected(): Promise<{ adapter: CodexAppServerAdapter, transport: RecordingTransport }> {
  const transport = new RecordingTransport()
  const adapter = new CodexAppServerAdapter(() => transport)
  await adapter.connect()
  return { adapter, transport }
}

function refusal(file: string): string {
  return `Codex would load ${file} from this worktree, and that file can start programs or change agent permissions. `
    + "Domovoi does not load repository-brought configuration until a trust gate ships. "
    + `Remove ${file} from this worktree or use another provider here.`
}

const sentMethods = (transport: RecordingTransport) => transport.sent.flatMap(({ method }) => method ? [method] : [])

// A trusted project's .codex folder is loaded by Codex itself: config.toml
// (MCP servers, hooks, permissions), hooks.json and rules/*.rules, from every
// directory between the session's directory and the project root.
describe("Codex repository configuration", () => {
  it.each([
    [".codex/config.toml", '[mcp_servers.probe]\ncommand = "/usr/bin/true"\n'],
    [".codex/hooks.json", "{}"],
    [".codex/rules/default.rules", 'prefix_rule(pattern = ["git"], decision = "allow")\n'],
  ])("refuses to start a session in a worktree holding %s, before Codex is asked anything", async (file, text) => {
    const cwd = repository({ [file]: text })
    const { adapter, transport } = await connected()

    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal(file))
    expect(sentMethods(transport)).toEqual(["initialize", "initialized"])
  })

  it("refuses to resume or continue a thread once the worktree holds it", async () => {
    const cwd = repository({ ".codex/config.toml": "model = \"probe\"\n" })
    const { adapter, transport } = await connected()

    await expect(adapter.resumeThread({ threadId: "thread-1", cwd, runtime })).rejects.toThrow(refusal(".codex/config.toml"))
    await expect(adapter.startTurn({ threadId: "thread-1", cwd, prompt: "hello", runtime })).rejects.toThrow(refusal(".codex/config.toml"))
    expect(sentMethods(transport)).toEqual(["initialize", "initialized"])
  })

  it("names a .codex folder between the session's directory and the project root", async () => {
    const root = repository({ "packages/app/.codex/config.toml": "model = \"probe\"\n", "packages/app/src/.keep": "" })
    const { adapter } = await connected()

    await expect(adapter.startThread({ cwd: join(root, "packages/app/src"), runtime }))
      .rejects.toThrow(refusal("packages/app/.codex/config.toml"))
  })

  it("starts a session when the worktree holds nothing Codex loads as configuration", async () => {
    const cwd = repository({ ".codex/mcp.json": "{}", "codex.toml": "model = \"probe\"\n", "README.md": "" })
    const { adapter, transport } = await connected()

    await adapter.startThread({ cwd, runtime }).catch(() => undefined)
    expect(sentMethods(transport)).toEqual(["initialize", "initialized", "config/read", "thread/start"])
  })
})
