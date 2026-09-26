import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { waitForDaemon } from "./test-wait-for.js"
import type { Runtime } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AcpPeer, AcpPeerHandlers, AcpSessionSetup, AcpUpdate } from "./acp.js"
import { AcpAgentAdapter } from "./acp.js"
import { CURSOR_ACP_PROVIDER, GROK_ACP_PROVIDER, type AcpProviderDefinition } from "./acp-providers.js"
import type { AgentEvent } from "./agents.js"
import { classifyProviderFailure } from "./provider-failures.js"

// Lets a test make directory watchers fail to install, or install and never
// report, as a watcher that drops events does.
const directoryWatch = vi.hoisted(() => ({ mode: "real" as "real" | "silent" | "fail" }))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      if (directoryWatch.mode === "fail") throw Object.assign(new Error("too many open files"), { code: "EMFILE" })
      if (directoryWatch.mode === "silent") {
        return Object.assign(new EventEmitter(), { close: () => undefined, ref() { return this }, unref() { return this } })
      }
      return actual.watch(...args)
    },
  }
})

const runtime: Runtime = {
  provider: "cursor-agent",
  model: "gpt-5.4",
  reasoning: "high",
  permissionMode: "plan",
  auto: false,
}

class FakePeer implements AcpPeer {
  handlers?: AcpPeerHandlers
  setup: AcpSessionSetup = {
    sessionId: "acp-session",
    modes: ["ask", "plan", "agent"],
    configOptions: [
      { id: "model", category: "model", values: ["gpt-5.4"], currentValue: "auto" },
      { id: "thinking", category: "thought_level", values: ["low", "high"], currentValue: "low" },
    ],
  }
  initialize = vi.fn(async () => undefined)
  startSession = vi.fn(async () => this.setup)
  resumeSession = vi.fn(async () => this.setup)
  closeSession = vi.fn(async () => undefined)
  setMode = vi.fn(async () => undefined)
  setConfig = vi.fn(async () => undefined)
  prompt = vi.fn(async () => ({ stopReason: "end_turn" }))
  cancel = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
}

function createHarness() {
  const peer = new FakePeer()
  const adapter = new AcpAgentAdapter({
    definition: CURSOR_ACP_PROVIDER,
    createPeer: (handlers) => {
      peer.handlers = handlers
      return peer
    },
    listModels: async () => [{
      provider: "cursor-agent",
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "",
      supportedReasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
      isDefault: true,
    }],
    createId: vi.fn()
      .mockReturnValueOnce("local-turn")
      .mockReturnValueOnce("approval-1"),
  })
  return { adapter, peer }
}

describe("AcpAgentAdapter", () => {
  it("discards a timed-out peer and isolates its late initialization", async () => {
    let finishFirstInitialization!: () => void
    const firstPeer = new FakePeer()
    firstPeer.initialize.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishFirstInitialization = () => resolve(undefined)
    }))
    const secondPeer = new FakePeer()
    secondPeer.setup = { ...secondPeer.setup, sessionId: "fresh-session" }
    const createPeer = vi.fn()
      .mockReturnValueOnce(firstPeer)
      .mockReturnValueOnce(secondPeer)
    const adapter = new AcpAgentAdapter({
      definition: CURSOR_ACP_PROVIDER,
      createPeer,
      listModels: async () => [],
    })

    const staleConnection = adapter.connect()
    await adapter.resetConnection()
    expect(firstPeer.close).toHaveBeenCalledOnce()

    await expect(adapter.connect()).resolves.toBeUndefined()
    finishFirstInitialization()
    await expect(staleConnection).rejects.toThrow("ACP connection reset during initialization")
    expect(firstPeer.close).toHaveBeenCalledOnce()
    await expect(adapter.startThread({ cwd: "/repo", runtime })).resolves.toBe("fresh-session")
    expect(secondPeer.startSession).toHaveBeenCalledOnce()
    expect(firstPeer.startSession).not.toHaveBeenCalled()
  })

  it("closes a failed peer and creates a fresh peer on retry", async () => {
    const failedPeer = new FakePeer()
    failedPeer.initialize.mockRejectedValueOnce(new Error("initialize failed"))
    const retryPeer = new FakePeer()
    const createPeer = vi.fn()
      .mockReturnValueOnce(failedPeer)
      .mockReturnValueOnce(retryPeer)
    const adapter = new AcpAgentAdapter({
      definition: CURSOR_ACP_PROVIDER,
      createPeer,
      listModels: async () => [],
    })

    await expect(adapter.connect()).rejects.toThrow("initialize failed")
    expect(failedPeer.close).toHaveBeenCalledOnce()
    await expect(adapter.connect()).resolves.toBeUndefined()
    expect(retryPeer.initialize).toHaveBeenCalledOnce()
    expect(createPeer).toHaveBeenCalledTimes(2)
  })

  it("negotiates model, reasoning, and the provider's safe mode", async () => {
    const { adapter, peer } = createHarness()
    await adapter.connect()

    expect(await adapter.startThread({ cwd: "/repo", runtime })).toBe("acp-session")
    expect(peer.initialize).toHaveBeenCalledOnce()
    expect(peer.startSession).toHaveBeenCalledWith("/repo")
    expect(peer.setConfig).toHaveBeenNthCalledWith(1, "acp-session", "model", "gpt-5.4")
    expect(peer.setConfig).toHaveBeenNthCalledWith(2, "acp-session", "thinking", "high")
    expect(peer.setMode).toHaveBeenCalledWith("acp-session", "plan")
  })

  it("omits an unavailable reasoning config when runtime reasoning is none", async () => {
    const { adapter, peer } = createHarness()
    await adapter.connect()

    await expect(adapter.startThread({
      cwd: "/repo",
      runtime: { ...runtime, reasoning: "none" },
    })).resolves.toBe("acp-session")
    expect(peer.setConfig).toHaveBeenCalledOnce()
    expect(peer.setConfig).toHaveBeenCalledWith("acp-session", "model", "gpt-5.4")
  })

  it("rejects unadvertised modes instead of silently widening permissions", async () => {
    const { adapter, peer } = createHarness()
    peer.setup.modes = ["agent"]
    await adapter.connect()

    await expect(adapter.startThread({ cwd: "/repo", runtime })).rejects.toThrow(
      "does not advertise mode plan",
    )
  })

  it("streams updates and completes an asynchronous prompt with a local turn id", async () => {
    const { adapter, peer } = createHarness()
    const events: unknown[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })
    peer.prompt.mockImplementation(async () => {
      peer.handlers?.onUpdate("acp-session", {
        type: "text",
        text: "Working",
      })
      peer.handlers?.onUpdate("acp-session", {
        type: "tool",
        toolCallId: "tool-1",
        phase: "started",
        title: "Run tests",
      })
      peer.handlers?.onUpdate("acp-session", {
        type: "plan",
        steps: [
          { text: "Inspect", status: "completed" },
          { text: "Run tests", status: "in-progress" },
        ],
      })
      return { stopReason: "end_turn" }
    })

    expect(await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "Ship it", runtime }))
      .toBe("local-turn")
    await waitForDaemon(() => expect(events).toContainEqual({
      type: "turn-completed",
      params: { threadId: "acp-session", turnId: "local-turn", status: "completed" },
    }))
    expect(events).toContainEqual({
      type: "text-delta",
      threadId: "acp-session",
      turnId: "local-turn",
      delta: "Working",
    })
    expect(events).toContainEqual({
      type: "plan-updated",
      threadId: "acp-session",
      turnId: "local-turn",
      steps: [
        { text: "Inspect", status: "completed" },
        { text: "Run tests", status: "in-progress" },
      ],
    })
    expect(events).toContainEqual(expect.objectContaining({ type: "item", phase: "started" }))
  })

  it("maps project grants to allow-once and cancellation drains pending permissions", async () => {
    const { adapter, peer } = createHarness()
    const events: unknown[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })

    const permission = peer.handlers!.onPermission({
      sessionId: "acp-session",
      toolCallId: "tool-1",
      title: "Write file",
      options: [
        { id: "once", kind: "allow_once" },
        { id: "always", kind: "allow_always" },
        { id: "reject", kind: "reject_once" },
      ],
    })
    const approval = events.find((event): event is { requestId: number } => (
      typeof event === "object" && event !== null && "requestId" in event
    ))
    adapter.resolveApproval(approval!.requestId, "always-project")
    await expect(permission).resolves.toEqual({ optionId: "once" })

    const cancelled = peer.handlers!.onPermission({
      sessionId: "acp-session",
      toolCallId: "tool-2",
      title: "Run command",
      options: [{ id: "once", kind: "allow_once" }],
    })
    await adapter.interruptTurn("acp-session", "local-turn")
    await expect(cancelled).resolves.toEqual({ cancelled: true })
    expect(peer.cancel).toHaveBeenCalledWith("acp-session")
  })

  it("cancels an active turn before closing a session", async () => {
    const { adapter, peer } = createHarness()
    peer.prompt.mockImplementation(() => new Promise(() => {}))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })
    await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "Ship it", runtime })

    await adapter.stopThread("acp-session")

    expect(peer.cancel).toHaveBeenCalledWith("acp-session")
    expect(peer.closeSession).toHaveBeenCalledWith("acp-session")
    expect(peer.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      peer.closeSession.mock.invocationCallOrder[0]!,
    )
  })

  it("declares Cursor Ask read-only and build-auto unsupported", async () => {
    const { adapter } = createHarness()
    expect(adapter.permissionCapabilities).toEqual({
      ask: "read-only",
      buildAuto: "unsupported",
    })
    await expect(adapter.steerTurn("thread", "turn", "change course")).rejects.toThrow(
      "does not support mid-turn steering",
    )
  })

  it("reports provider disconnects once with a redacted peer reason", async () => {
    const { adapter, peer } = createHarness()
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    peer.handlers?.onDisconnect("cursor-agent exited with code 1: token=super-secret\n401 token expired")
    peer.handlers?.onDisconnect("again")

    expect(events).toHaveLength(1)
    const event = events[0]
    if (event?.type !== "provider-disconnected") throw new Error("expected a disconnect event")
    expect(event.reason).not.toMatch(/super-secret/)
    expect(event.reason).toContain("cursor-agent exited with code 1")
    expect(event.reason).toContain("401 token expired")
    expect(classifyProviderFailure(new Error(event.reason)).kind).toBe("authentication-expired")
  })

  it("falls back to a generic reason when the peer reports none", async () => {
    const { adapter, peer } = createHarness()
    const events: unknown[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    peer.handlers?.onDisconnect()

    expect(events).toEqual([{
      type: "provider-disconnected",
      reason: "Provider process exited unexpectedly",
    }])
  })

  it("recovers from disconnect without letting a stale peer clear its replacement", async () => {
    const firstPeer = new FakePeer()
    firstPeer.prompt.mockImplementation(() => new Promise(() => {}))
    const replacementPeer = new FakePeer()
    replacementPeer.prompt.mockImplementation(() => new Promise(() => {}))
    const peers = [firstPeer, replacementPeer]
    const createPeer = vi.fn((handlers: AcpPeerHandlers) => {
      const peer = peers.shift()!
      peer.handlers = handlers
      return peer
    })
    const adapter = new AcpAgentAdapter({
      definition: CURSOR_ACP_PROVIDER,
      createPeer,
      listModels: async () => [],
      createId: vi.fn()
        .mockReturnValueOnce("first-turn")
        .mockReturnValueOnce("replacement-turn"),
    })
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))

    await adapter.connect()
    await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "first", runtime })
    firstPeer.handlers!.onDisconnect()
    await adapter.connect()
    await expect(adapter.startTurn({
      threadId: "acp-session",
      cwd: "/repo",
      prompt: "replacement",
      runtime,
    })).resolves.toBe("replacement-turn")

    firstPeer.handlers!.onUpdate("acp-session", { type: "text", text: "stale update" })
    const stalePermission = firstPeer.handlers!.onPermission({
      sessionId: "acp-session",
      toolCallId: "stale-tool",
      title: "Stale permission",
      options: [{ id: "once", kind: "allow_once" }],
    })
    replacementPeer.handlers!.onUpdate("acp-session", { type: "text", text: "current update" })

    await expect(stalePermission).resolves.toEqual({ cancelled: true })
    expect(events).not.toContainEqual(expect.objectContaining({ delta: "stale update" }))
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "approval-requested",
      itemId: "stale-tool",
    }))
    expect(events).toContainEqual(expect.objectContaining({ delta: "current update" }))

    firstPeer.handlers!.onDisconnect()
    await expect(adapter.startThread({ cwd: "/repo", runtime })).resolves.toBe("acp-session")
    expect(replacementPeer.initialize).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === "provider-disconnected")).toHaveLength(1)
  })

  it("emits ACP-reported context without inventing a token breakdown", async () => {
    const { adapter, peer } = createHarness()
    const events: AgentEvent[] = []
    peer.prompt.mockImplementation(() => new Promise(() => {}))
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })
    await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "Ship it", runtime })
    peer.handlers?.onUpdate("acp-session", {
      type: "usage",
      used: 100,
      size: 10_000,
      cost: { amount: 0.01, currency: "USD" },
    } satisfies AcpUpdate)

    expect(events).toContainEqual({
      type: "usage",
      threadId: "acp-session",
      turnId: "local-turn",
      source: { kind: "session", tokens: "unavailable" },
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        contextTokens: 100,
        contextWindowTokens: 10_000,
        costMicros: 10_000,
        currency: "USD",
        costSource: "provider-reported",
      },
    })
  })
})

// Cursor and Grok read MCP servers, hooks, permission rules and other
// program-starting files from the session's directory and the directories up
// to the repository root. Until a repository can be trusted, the adapter
// refuses a session whose worktree holds one, before the agent is asked.
describe("ACP repository configuration", () => {
  const scratch: string[] = []
  afterEach(() => {
    vi.useRealTimers()
    directoryWatch.mode = "real"
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  const unchecked = (name: string) =>
    `Domovoi could not check this worktree for ${name} configuration that can start programs or change agent permissions, so ${name} is not run here. `
    + "Domovoi does not load repository-brought configuration until a trust gate ships."

  function worktree(files: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "domovoi-acp-config-"))
    scratch.push(root)
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
    write(root, files)
    return root
  }

  function write(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
  }

  function connected(definition: AcpProviderDefinition = CURSOR_ACP_PROVIDER) {
    const peer = new FakePeer()
    const adapter = new AcpAgentAdapter({
      definition,
      createPeer: () => peer,
      listModels: async () => [],
      createId: () => "local-turn",
    })
    return { adapter, peer }
  }

  const refusal = (name: string, file: string) =>
    `${name} would load ${file} from this worktree, and that file can start programs or change agent permissions. `
    + "Domovoi does not load repository-brought configuration until a trust gate ships. "
    + `Remove ${file} from this worktree or use another provider here.`

  it.each([
    ["Cursor", ".cursor/mcp.json", CURSOR_ACP_PROVIDER],
    ["Cursor", ".cursor/hooks.json", CURSOR_ACP_PROVIDER],
    ["Cursor", ".cursor/cli.json", CURSOR_ACP_PROVIDER],
    ["Cursor", ".claude/settings.json", CURSOR_ACP_PROVIDER],
    ["Cursor", ".mcp.json", CURSOR_ACP_PROVIDER],
    ["Grok", ".grok/config.toml", GROK_ACP_PROVIDER],
    ["Grok", ".grok/hooks/pre-tool.json", GROK_ACP_PROVIDER],
    ["Grok", ".mcp.json", GROK_ACP_PROVIDER],
    ["Grok", ".cursor/mcp.json", GROK_ACP_PROVIDER],
    ["Grok", ".claude/settings.local.json", GROK_ACP_PROVIDER],
    ["Grok", ".envrc", GROK_ACP_PROVIDER],
  ] as const)("refuses to start %s in a worktree holding %s", async (name, file, definition) => {
    const cwd = worktree({ [file]: "{}\n" })
    const { adapter, peer } = connected(definition)
    await adapter.connect()

    const shown = file.startsWith(".grok/hooks/") ? ".grok/hooks" : file
    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal(name, shown))
    expect(peer.startSession).not.toHaveBeenCalled()
  })

  it.each([
    ["Cursor", CURSOR_ACP_PROVIDER],
    ["Grok", GROK_ACP_PROVIDER],
  ] as const)("refuses %s for every file on its held-back list", async (name, definition) => {
    expect(definition.heldBackRepositoryFiles.length).toBeGreaterThan(0)
    for (const file of definition.heldBackRepositoryFiles) {
      const cwd = worktree({ [file]: "{}\n" })
      const { adapter, peer } = connected(definition)
      await adapter.connect()
      await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal(name, file))
      expect(peer.startSession).not.toHaveBeenCalled()
    }
  })

  it("refuses to resume a session whose worktree gained a held-back file", async () => {
    const cwd = worktree({ ".cursor/mcp.json": "{}\n" })
    const { adapter, peer } = connected()
    await adapter.connect()

    await expect(adapter.resumeThread({ threadId: "acp-session", cwd, runtime }))
      .rejects.toThrow(refusal("Cursor", ".cursor/mcp.json"))
    expect(peer.resumeSession).not.toHaveBeenCalled()
  })

  it("refuses a turn once the worktree holds a held-back file", async () => {
    const cwd = worktree()
    const { adapter, peer } = connected()
    await adapter.connect()
    await expect(adapter.startThread({ cwd, runtime })).resolves.toBe("acp-session")
    write(cwd, { ".cursor/mcp.json": "{}\n" })

    await expect(adapter.startTurn({ threadId: "acp-session", cwd, prompt: "Ship it", runtime }))
      .rejects.toThrow(refusal("Cursor", ".cursor/mcp.json"))
    expect(peer.prompt).not.toHaveBeenCalled()
  })

  it.each([
    ["Cursor", CURSOR_ACP_PROVIDER],
    ["Grok", GROK_ACP_PROVIDER],
  ] as const)("still starts %s in a worktree that holds only instruction files", async (_name, definition) => {
    const cwd = worktree({ "AGENTS.md": "# Rules\n", "CLAUDE.md": "# Rules\n", ".cursor/rules/style.mdc": "Be brief.\n" })
    const { adapter, peer } = connected(definition)
    await adapter.connect()

    await expect(adapter.startThread({ cwd, runtime })).resolves.toBe("acp-session")
    await expect(adapter.startTurn({ threadId: "acp-session", cwd, prompt: "Ship it", runtime })).resolves.toBe("local-turn")
    expect(peer.startSession).toHaveBeenCalledWith(cwd)
  })

  it("counts a symbolic link, even a dangling one, as the file", async () => {
    const cwd = worktree()
    mkdirSync(join(cwd, ".cursor"))
    symlinkSync(join(cwd, "missing.json"), join(cwd, ".cursor", "mcp.json"))
    const { adapter } = connected()
    await adapter.connect()

    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal("Cursor", ".cursor/mcp.json"))
  })

  it("checks every directory from a nested session directory up to the repository root", async () => {
    const root = worktree({ "packages/app/src/index.ts": "" })
    const cwd = join(root, "packages", "app")
    const { adapter } = connected()
    await adapter.connect()

    write(root, { "packages/.cursor/hooks.json": "{}\n" })
    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal("Cursor", "packages/.cursor/hooks.json"))
    rmSync(join(root, "packages", ".cursor"), { recursive: true })
    write(root, { ".cursor/mcp.json": "{}\n" })
    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal("Cursor", ".cursor/mcp.json"))
  })

  it("does not look above the repository root", async () => {
    const outer = mkdtempSync(join(tmpdir(), "domovoi-acp-outer-"))
    scratch.push(outer)
    write(outer, { ".cursor/mcp.json": "{}\n", "repo/.git/HEAD": "ref: refs/heads/main\n" })
    const { adapter } = connected()
    await adapter.connect()

    await expect(adapter.startThread({ cwd: join(outer, "repo"), runtime })).resolves.toBe("acp-session")
  })

  it("resolves a session directory reached through a link to the repository it is in", async () => {
    const root = worktree({ "packages/app/src/index.ts": "", ".grok/hooks/pre-tool.json": "{}\n" })
    const aliases = mkdtempSync(join(tmpdir(), "domovoi-acp-alias-"))
    scratch.push(aliases)
    symlinkSync(join(root, "packages", "app"), join(aliases, "app"))
    const { adapter } = connected(GROK_ACP_PROVIDER)
    await adapter.connect()

    await expect(adapter.startThread({ cwd: join(aliases, "app"), runtime })).rejects.toThrow(refusal("Grok", ".grok/hooks"))
  })

  it("checks every directory above a session directory that is in no repository", async () => {
    const outer = mkdtempSync(join(tmpdir(), "domovoi-acp-plain-"))
    scratch.push(outer)
    write(outer, { ".cursor/mcp.json": "{}\n", "inner/notes.txt": "" })
    const { adapter } = connected()
    await adapter.connect()

    await expect(adapter.startThread({ cwd: join(outer, "inner"), runtime }))
      .rejects.toThrow(refusal("Cursor", "../.cursor/mcp.json"))
  })

  it("refuses a configuration folder that is a link, without following it", async () => {
    const cwd = worktree()
    const elsewhere = mkdtempSync(join(tmpdir(), "domovoi-acp-elsewhere-"))
    scratch.push(elsewhere)
    symlinkSync(elsewhere, join(cwd, ".cursor"))
    const { adapter } = connected()
    await adapter.connect()

    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(refusal("Cursor", ".cursor/mcp.json"))
  })

  it.each(["start", "resume"] as const)("stops the agent when a held-back file appears in a session it can %s", async (entry) => {
    const root = worktree({ "packages/app/src/index.ts": "" })
    const cwd = join(root, "packages", "app")
    const { adapter, peer } = connected()
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    if (entry === "start") await adapter.startThread({ cwd, runtime })
    else await adapter.resumeThread({ threadId: "acp-session", cwd, runtime })

    mkdirSync(join(root, ".cursor"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    writeFileSync(join(root, ".cursor", "hooks.json"), "{}\n")

    await waitForDaemon(() => expect(events).toContainEqual({
      type: "provider-disconnected",
      reason: refusal("Cursor", ".cursor/hooks.json"),
    }))
    expect(peer.close).toHaveBeenCalledOnce()
  })

  it("finds a held-back file by a periodic check when the watchers report nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
    directoryWatch.mode = "silent"
    const cwd = worktree()
    const { adapter, peer } = connected()
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd, runtime })
    await vi.advanceTimersByTimeAsync(1_000)

    write(cwd, { ".cursor/hooks.json": "{}\n" })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(events).toContainEqual({ type: "provider-disconnected", reason: refusal("Cursor", ".cursor/hooks.json") })
    expect(peer.close).toHaveBeenCalledOnce()
  })

  it("stops the agent when a directory it watches can no longer be checked", async () => {
    const root = worktree({ "packages/app/src/index.ts": "" })
    const cwd = join(root, "packages", "app")
    const { adapter, peer } = connected()
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd, runtime })

    symlinkSync(".git", join(cwd, ".git"))

    await waitForDaemon(() => expect(events).toContainEqual({ type: "provider-disconnected", reason: unchecked("Cursor") }))
    expect(peer.close).toHaveBeenCalledOnce()
  })

  it("refuses a session whose directories cannot be watched", async () => {
    directoryWatch.mode = "fail"
    const cwd = worktree()
    const { adapter, peer } = connected()
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()

    await expect(adapter.startThread({ cwd, runtime })).rejects.toThrow(unchecked("Cursor"))
    expect(events).toContainEqual({ type: "provider-disconnected", reason: unchecked("Cursor") })
    expect(peer.close).toHaveBeenCalledOnce()
  })

  it("stops the agent rather than watch more directories than it can bound", async () => {
    const { adapter, peer } = connected()
    let opened = 0
    peer.startSession.mockImplementation(async () => ({ ...peer.setup, sessionId: `session-${opened++}` }))
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()

    let refused: unknown
    for (let index = 0; index < 300 && refused === undefined; index += 1) {
      await adapter.startThread({ cwd: worktree(), runtime }).catch((error: unknown) => { refused = error })
    }
    expect(refused).toEqual(new Error(unchecked("Cursor")))
    expect(events).toContainEqual({ type: "provider-disconnected", reason: unchecked("Cursor") })
  })

  it.each(["start", "resume"] as const)("closes a session it could %s but not configure", async (entry) => {
    const cwd = worktree()
    const { adapter, peer } = connected()
    peer.setMode.mockRejectedValueOnce(new Error("mode refused"))
    await adapter.connect()

    const opening = entry === "start"
      ? adapter.startThread({ cwd, runtime })
      : adapter.resumeThread({ threadId: "acp-session", cwd, runtime })
    await expect(opening).rejects.toThrow("mode refused")
    expect(peer.closeSession).toHaveBeenCalledWith("acp-session")
  })

  it("names every held-back file in the daemon README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    const section = readme.slice(readme.indexOf("## Repository configuration"), readme.indexOf("## Supervise"))
    for (const definition of [CURSOR_ACP_PROVIDER, GROK_ACP_PROVIDER]) {
      for (const file of definition.heldBackRepositoryFiles) expect(section).toContain(`\`${file}\``)
    }
  })
})
