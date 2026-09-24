import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import { CodexAppServerAdapter, type CodexTransport, type JsonRpcMessage } from "./codex.js"

type Reply = (method: string) => Pick<JsonRpcMessage, "result" | "error">

class RecordingTransport implements CodexTransport {
  readonly sent: JsonRpcMessage[] = []
  #listener: ((message: JsonRpcMessage) => void) | undefined
  readonly #reply: Reply

  constructor(reply: Reply = () => ({ result: {} })) {
    this.#reply = reply
  }

  send(message: JsonRpcMessage): void {
    this.sent.push(message)
    const { id, method } = message
    if (id !== undefined) queueMicrotask(() => this.#listener?.({ id, ...this.#reply(method ?? "") }))
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

async function connected(reply?: Reply): Promise<{ adapter: CodexAppServerAdapter, transport: RecordingTransport }> {
  const transport = new RecordingTransport(reply)
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

  it("refuses thread/start when the file appears while Codex answers config/read", async () => {
    const cwd = repository({ "README.md": "" })
    const { adapter, transport } = await connected((method) => {
      if (method === "config/read") write(cwd, { ".codex/config.toml": '[mcp_servers.probe]\ncommand = "/usr/bin/true"\n' })
      return { result: {} }
    })

    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal(".codex/config.toml"))
    expect(sentMethods(transport)).toEqual(["initialize", "initialized", "config/read"])
  })

  it("refuses a retried turn/start when the file appears while Codex answers the first attempt", async () => {
    const cwd = repository({ "README.md": "" })
    const { adapter, transport } = await connected((method) => {
      if (method !== "turn/start") return { result: {} }
      write(cwd, { ".codex/hooks.json": "{}" })
      return { error: { message: "turn/start.additionalContext requires experimentalApi capability" } }
    })

    await expect(adapter.startTurn({ threadId: "thread-1", cwd, prompt: "hello", runtime })).rejects.toThrow(refusal(".codex/hooks.json"))
    expect(sentMethods(transport)).toEqual(["initialize", "initialized", "turn/start"])
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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Domovoi Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" })
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

// A session worktree is a linked git worktree. Codex resolves the main
// checkout from the worktree's .git file (gitdir, then the common directory)
// and takes hook declarations from the main checkout's matching .codex folder.
function linkedWorktree(committed: Record<string, string>, mainOnly: Record<string, string>): { main: string, worktree: string } {
  const main = repository(committed)
  git(main, "add", "-A")
  git(main, "commit", "-q", "--allow-empty", "-m", "initial")
  write(main, mainOnly)
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "domovoi-codex-worktree-")))
  directories.push(parent)
  const worktree = join(parent, "session")
  git(main, "worktree", "add", "-q", "-b", "domovoi/session", worktree)
  return { main, worktree }
}

function mainCheckoutRefusal(file: string, main: string): string {
  return `Codex would load ${file} from this repository's main checkout at ${main}, and that file can start programs or change agent permissions. `
    + "Domovoi does not load repository-brought configuration until a trust gate ships. "
    + `Remove ${file} from the main checkout or use another provider here.`
}

describe("Codex configuration in the repository's main checkout", () => {
  it.each([
    [".codex/hooks.json", "{}"],
    [".codex/config.toml", '[hooks]\n[[hooks.PreToolUse]]\nmatcher = "*"\n'],
  ])("refuses a clean session worktree when the main checkout holds %s, before Codex is asked anything", async (file, text) => {
    const { main, worktree } = linkedWorktree({ "README.md": "" }, { [file]: text })
    const { adapter, transport } = await connected()

    await expect(adapter.startThread({ cwd: worktree, runtime })).rejects.toThrow(mainCheckoutRefusal(file, main))
    await expect(adapter.resumeThread({ threadId: "thread-1", cwd: worktree, runtime })).rejects.toThrow(mainCheckoutRefusal(file, main))
    await expect(adapter.startTurn({ threadId: "thread-1", cwd: worktree, prompt: "hello", runtime }))
      .rejects.toThrow(mainCheckoutRefusal(file, main))
    expect(sentMethods(transport)).toEqual(["initialize", "initialized"])
  })

  it("names the main checkout's .codex folder matching a directory between the session's directory and the worktree root", async () => {
    const { main, worktree } = linkedWorktree(
      { "packages/app/src/.keep": "" },
      { "packages/app/.codex/hooks.json": "{}" },
    )
    const { adapter } = await connected()

    await expect(adapter.startThread({ cwd: join(worktree, "packages/app/src"), runtime }))
      .rejects.toThrow(mainCheckoutRefusal("packages/app/.codex/hooks.json", main))
  })

  it("refuses thread/start when the main checkout gains hook configuration while Codex answers config/read", async () => {
    const { main, worktree } = linkedWorktree({ "README.md": "" }, {})
    const { adapter, transport } = await connected((method) => {
      if (method === "config/read") write(main, { ".codex/hooks.json": "{}" })
      return { result: {} }
    })

    await expect(adapter.startThread({ cwd: worktree, runtime })).rejects.toThrow(mainCheckoutRefusal(".codex/hooks.json", main))
    expect(sentMethods(transport)).toEqual(["initialize", "initialized", "config/read"])
  })

  it("starts a session when the main checkout holds nothing Codex loads from it", async () => {
    const { worktree } = linkedWorktree({ "README.md": "" }, { ".codex/mcp.json": "{}", ".codex/rules/default.rules": "" })
    const { adapter, transport } = await connected()

    await adapter.startThread({ cwd: worktree, runtime }).catch(() => undefined)
    expect(sentMethods(transport)).toEqual(["initialize", "initialized", "config/read", "thread/start"])
  })

  it("keeps the worktree refusal when the worktree itself holds the file", async () => {
    const { worktree } = linkedWorktree({ ".codex/config.toml": "model = \"probe\"\n" }, {})
    const { adapter, transport } = await connected()

    await expect(adapter.startThread({ cwd: worktree, runtime })).rejects.toThrow(refusal(".codex/config.toml"))
    expect(sentMethods(transport)).toEqual(["initialize", "initialized"])
  })
})
