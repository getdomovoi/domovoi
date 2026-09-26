import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AcpAgentAdapter } from "./acp.js"
import { CURSOR_ACP_PROVIDER } from "./acp-providers.js"
import { mapAcpSessionSetup, mapAcpUpdate, StdioAcpPeer } from "./acp-stdio.js"
import { classifyProviderFailure } from "./provider-failures.js"

vi.mock("@getdomovoi/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@getdomovoi/protocol")>(),
  buildVersion: "9.8.7-test",
}))

// Peers here start fake children that never exit, so their launch folders go
// in a scratch temporary folder that is removed with the file's tests.
const temporaryVariables = ["TMPDIR", "TMP", "TEMP"] as const
const outerTemporary = Object.fromEntries(temporaryVariables.map((name) => [name, process.env[name]]))
const temporaryRoot = mkdtempSync(join(tmpdir(), "domovoi-acp-stdio-test-"))
beforeAll(() => {
  for (const name of temporaryVariables) process.env[name] = temporaryRoot
})
afterAll(() => {
  for (const name of temporaryVariables) {
    if (outerTemporary[name] === undefined) delete process.env[name]
    else process.env[name] = outerTemporary[name]
  }
  rmSync(temporaryRoot, { recursive: true, force: true })
})

function fakeAcpProcess(response: (id: number) => object) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  let input = ""
  child.stdin.on("data", (chunk) => {
    input += chunk.toString()
    while (input.includes("\n")) {
      const newline = input.indexOf("\n")
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (!line) continue
      const request = JSON.parse(line) as { id: number }
      child.stdout.write(`${JSON.stringify(response(request.id))}\n`)
    }
  })
  child.kill.mockImplementation(() => {
    child.emit("exit", 1, null)
    return true
  })
  return child
}

async function initializePeer(child: ReturnType<typeof fakeAcpProcess>) {
  const onDisconnect = vi.fn()
  const peer = new StdioAcpPeer({
    definition: CURSOR_ACP_PROVIDER,
    handlers: {
      onUpdate: vi.fn(),
      onPermission: vi.fn(),
      onDisconnect,
    },
    spawnProcess: () => {
      queueMicrotask(() => child.emit("spawn"))
      return child as unknown as ChildProcessWithoutNullStreams
    },
  })
  await peer.initialize()
  return { onDisconnect, peer }
}

describe("ACP stdio mapping", () => {
  // A daemon started inside a repository must not hand that repository to the
  // agent as its process directory, where it could load project configuration
  // at startup. The session's worktree reaches the agent as the ACP session cwd.
  it("starts the agent in an empty private directory and names the worktree only as the session cwd", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, sessionId: "acp-session" },
    }))
    const requests: { method?: string; params?: { cwd?: string } }[] = []
    child.stdin.on("data", (bytes: Buffer) => { requests.push(JSON.parse(bytes.toString())) })
    const spawnCwds: (string | undefined)[] = []
    const peer = new StdioAcpPeer({
      definition: CURSOR_ACP_PROVIDER,
      handlers: { onUpdate: vi.fn(), onPermission: vi.fn(), onDisconnect: vi.fn() },
      spawnProcess: (_command, _args, options?: { cwd?: string }) => {
        spawnCwds.push(options?.cwd)
        queueMicrotask(() => child.emit("spawn"))
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    await peer.initialize()
    const [cwd] = spawnCwds
    expect(cwd).toEqual(expect.any(String))
    expect(realpathSync(cwd!)).not.toBe(realpathSync(process.cwd()))
    expect(readdirSync(cwd!)).toEqual([])

    await peer.startSession("/work/session-worktree")
    expect(requests.find((request) => request.method === "session/new")?.params?.cwd).toBe("/work/session-worktree")
    await peer.close()
    expect(existsSync(cwd!)).toBe(false)
  })

  describe("launch folder", () => {
    let saved: Record<string, string | undefined> = {}
    const scratch: string[] = []
    beforeEach(() => {
      saved = Object.fromEntries(["TMPDIR", "TMP", "TEMP", "OLDPWD", "INIT_CWD"].map((name) => [name, process.env[name]]))
    })
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
    })

    function useTemporaryRoot(root: string): void {
      process.env.TMPDIR = root
      process.env.TMP = root
      process.env.TEMP = root
    }

    function launching() {
      const child = fakeAcpProcess((id) => ({
        jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
      }))
      const spawnProcess = vi.fn((_command: string, _args: readonly string[], _options: { cwd: string; env?: NodeJS.ProcessEnv }) => {
        queueMicrotask(() => child.emit("spawn"))
        return child as unknown as ChildProcessWithoutNullStreams
      })
      const peer = new StdioAcpPeer({
        definition: CURSOR_ACP_PROVIDER,
        handlers: { onUpdate: vi.fn(), onPermission: vi.fn(), onDisconnect: vi.fn() },
        spawnProcess,
      })
      return { peer, spawnProcess }
    }

    it("refuses to start the agent when the temporary folder is inside a repository with held-back configuration", async () => {
      const repository = mkdtempSync(join(tmpdir(), "domovoi-acp-launch-repo-"))
      scratch.push(repository)
      mkdirSync(join(repository, ".git"))
      writeFileSync(join(repository, ".git", "HEAD"), "ref: refs/heads/main\n")
      mkdirSync(join(repository, ".cursor"))
      writeFileSync(join(repository, ".cursor", "mcp.json"), "{}\n")
      mkdirSync(join(repository, "tmp"))
      useTemporaryRoot(join(repository, "tmp"))
      const { peer, spawnProcess } = launching()

      await expect(peer.initialize()).rejects.toThrow("cursor-agent cannot start in the temporary folder")
      expect(spawnProcess).not.toHaveBeenCalled()
      expect(readdirSync(join(repository, "tmp"))).toEqual([])
    })

    it("gives the agent its launch folder as PWD and drops other inherited working directories", async () => {
      process.env.OLDPWD = "/previous/checkout"
      process.env.INIT_CWD = "/daemon/checkout"
      const { peer, spawnProcess } = launching()
      await peer.initialize()
      const options = spawnProcess.mock.calls[0]?.[2]
      try {
        expect(options?.env?.PWD).toBe(options?.cwd)
        expect(options?.env?.OLDPWD).toBeUndefined()
        expect(options?.env?.INIT_CWD).toBeUndefined()
      } finally { await peer.close() }
    })

    it("removes launch folders a stopped daemon left behind, and keeps a running one's", async () => {
      const root = mkdtempSync(join(tmpdir(), "domovoi-acp-reap-"))
      scratch.push(root)
      useTemporaryRoot(root)
      const past = new Date(Date.now() - 24 * 60 * 60 * 1_000)
      const stale = join(root, "domovoi-acp-2147483646-stale")
      const running = join(root, `domovoi-acp-${process.pid}-running`)
      const recent = join(root, "domovoi-acp-2147483646-recent")
      for (const directory of [stale, running, recent]) mkdirSync(directory)
      utimesSync(stale, past, past)
      utimesSync(running, past, past)
      const { peer } = launching()

      await peer.initialize()
      try {
        expect(existsSync(stale)).toBe(false)
        expect(existsSync(running)).toBe(true)
        expect(existsSync(recent)).toBe(true)
      } finally { await peer.close() }
    })
  })

  it("identifies the running build to the provider", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const requests: unknown[] = []
    child.stdin.on("data", (bytes: Buffer) => { requests.push(JSON.parse(bytes.toString())) })
    const { peer } = await initializePeer(child)
    try {
      expect(requests[0]).toMatchObject({
        method: "initialize", params: { clientInfo: { name: "Domovoi", version: "9.8.7-test" } },
      })
    } finally { await peer.close() }
  })

  it("consumes each parsed fake-process request line", () => {
    const response = vi.fn((id: number) => ({ jsonrpc: "2.0", id, result: {} }))
    const child = fakeAcpProcess(response)

    child.stdin.write('{"id":1}\n{"id":2}\n')
    child.stdin.write('{"id":3}\n')

    expect(response.mock.calls).toEqual([[1], [2], [3]])
  })

  it("drains child stderr while the child is running", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const peer = new StdioAcpPeer({
      definition: CURSOR_ACP_PROVIDER,
      handlers: {
        onUpdate: vi.fn(),
        onPermission: vi.fn(),
        onDisconnect: vi.fn(),
      },
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"))
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    await peer.initialize()
    expect(child.stderr.readableFlowing).toBe(true)
    await peer.close()
  })

  it("carries the child's final stderr into the disconnect reason", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const { onDisconnect } = await initializePeer(child)

    child.stderr.write("401 token expired\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", 1, null)
    child.emit("close", 1, null)

    expect(onDisconnect).toHaveBeenCalledOnce()
    const reason = String(onDisconnect.mock.calls[0]?.[0])
    expect(reason).toContain("cursor-agent exited with code 1")
    expect(reason).toContain("401 token expired")
    expect(classifyProviderFailure(new Error(reason)).kind).toBe("authentication-expired")
  })

  it("reads stderr that arrives after the exit and before the streams close", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const { onDisconnect } = await initializePeer(child)

    child.emit("exit", 1, null)
    child.stderr.write("401 token expired\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("close", 1, null)

    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(String(onDisconnect.mock.calls[0]?.[0])).toContain("401 token expired")
  })

  it("still reports an exit whose streams a grandchild keeps open", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const { onDisconnect } = await initializePeer(child)
    vi.useFakeTimers()
    try {
      child.stderr.write("Not logged in\n")
      await vi.advanceTimersByTimeAsync(0)
      child.emit("exit", 1, null)
      expect(onDisconnect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(onDisconnect).toHaveBeenCalledOnce()
      expect(String(onDisconnect.mock.calls[0]?.[0])).toContain("Not logged in")
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps only the last 16 KiB of stderr in the disconnect reason", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const { onDisconnect } = await initializePeer(child)

    child.stderr.write(`${"x".repeat(20_000)}\n`)
    child.stderr.write("401 token expired\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", null, "SIGABRT")
    child.emit("close", null, "SIGABRT")

    const reason = String(onDisconnect.mock.calls[0]?.[0])
    expect(reason).toContain("cursor-agent exited from signal SIGABRT")
    expect(reason.endsWith("401 token expired")).toBe(true)
    expect(reason.length).toBeLessThanOrEqual(16_384 + "cursor-agent exited from signal SIGABRT: ".length)
  })

  it("waits for the ACP child to exit gracefully", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const { onDisconnect, peer } = await initializePeer(child)
    child.kill.mockImplementation(() => true)
    let closed = false

    const closing = peer.close().then(() => { closed = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    child.emit("exit", 0, null)
    await closing

    expect(child.kill).toHaveBeenCalledOnce()
    expect(onDisconnect).not.toHaveBeenCalled()
  })

  it("force-kills an ACP child after the graceful-close deadline", async () => {
    vi.useFakeTimers()
    try {
      const child = fakeAcpProcess((id) => ({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
      }))
      const { onDisconnect, peer } = await initializePeer(child)
      child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") child.emit("exit", 137, "SIGKILL")
        return true
      })

      const closing = peer.close()
      await vi.advanceTimersByTimeAsync(5_000)
      await closing

      expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]])
      expect(onDisconnect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits for the ACP child to exit after forcing shutdown", async () => {
    vi.useFakeTimers()
    try {
      const child = fakeAcpProcess((id) => ({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
      }))
      const { peer } = await initializePeer(child)
      child.kill.mockImplementation(() => true)
      let closed = false

      const closing = peer.close().then(() => { closed = true })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]])
      expect(closed).toBe(false)

      child.emit("exit", 137, "SIGKILL")
      await closing
      expect(closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds forced shutdown when the ACP child never exits", async () => {
    vi.useFakeTimers()
    try {
      const child = fakeAcpProcess((id) => ({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
      }))
      const { peer } = await initializePeer(child)
      child.kill.mockImplementation(() => true)
      let closed = false

      const closing = peer.close().then(() => { closed = true })
      await vi.advanceTimersByTimeAsync(1_999)
      expect(closed).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await closing
      expect(closed).toBe(true)
      expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ["already exited", () => false],
    ["signal error", () => { throw new Error("process unavailable") }],
  ])("safely closes when the ACP child has %s", async (_name, kill) => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const { peer } = await initializePeer(child)
    child.kill.mockImplementation(kill)

    await expect(peer.close()).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it.each([
    ["initialize rejection", (id: number) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32_000, message: "initialize failed" },
    })],
    ["protocol version mismatch", (id: number) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION + 1, agentCapabilities: {} },
    })],
  ])("terminates and clears the child after %s", async (_name, response) => {
    const child = fakeAcpProcess(response)
    const onDisconnect = vi.fn()
    const peer = new StdioAcpPeer({
      definition: CURSOR_ACP_PROVIDER,
      handlers: {
        onUpdate: vi.fn(),
        onPermission: vi.fn(),
        onDisconnect,
      },
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"))
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    await expect(peer.initialize()).rejects.toThrow()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(onDisconnect).not.toHaveBeenCalled()
    await expect(peer.startSession("/repo")).rejects.toThrow("not initialized")
  })

  it("terminates a child that finishes spawning after close() and rejects initialization", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const onDisconnect = vi.fn()
    const peer = new StdioAcpPeer({
      definition: CURSOR_ACP_PROVIDER,
      handlers: {
        onUpdate: vi.fn(),
        onPermission: vi.fn(),
        onDisconnect,
      },
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    })

    const initializing = peer.initialize()
    await peer.close()
    expect(child.kill).not.toHaveBeenCalled()
    child.emit("spawn")

    await expect(initializing).rejects.toThrow("closed during initialization")
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.stdout.readableFlowing).toBeNull()
    expect(onDisconnect).not.toHaveBeenCalled()
    await expect(peer.startSession("/repo")).rejects.toThrow("not initialized")
  })

  it("kills the provider CLI when the adapter resets while its peer is still spawning", async () => {
    const child = fakeAcpProcess((id) => ({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
    }))
    const adapter = new AcpAgentAdapter({
      definition: CURSOR_ACP_PROVIDER,
      createPeer: (handlers) => new StdioAcpPeer({
        definition: CURSOR_ACP_PROVIDER,
        handlers,
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      }),
      listModels: async () => [],
    })

    const staleConnection = adapter.connect()
    await adapter.resetConnection()
    child.emit("spawn")

    await expect(staleConnection).rejects.toThrow()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.stdout.readableFlowing).toBeNull()
  })

  it("maps advertised session modes and grouped config values", () => {
    expect(mapAcpSessionSetup({
      sessionId: "session-1",
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "agent", name: "Agent" },
        ],
      },
      configOptions: [{
        type: "select",
        id: "model-id",
        name: "Model",
        category: "model",
        currentValue: "auto",
        options: [{
          group: "recommended",
          name: "Recommended",
          options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
        }],
      }],
    })).toEqual({
      sessionId: "session-1",
      modes: ["ask", "agent"],
      configOptions: [{
        id: "model-id",
        category: "model",
        currentValue: "auto",
        values: ["gpt-5.4"],
      }],
    })
  })

  it("maps text, plans, tools, diffs, and usage without exposing thought chunks", () => {
    expect(mapAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    })).toEqual([{ type: "text", text: "hello" }])
    expect(mapAcpUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "private reasoning" },
    })).toEqual([])
    expect(mapAcpUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect it", priority: "high", status: "completed" },
        { content: "Test it", priority: "high", status: "in_progress" },
        { content: "Ship it", priority: "medium", status: "pending" },
      ],
    })).toEqual([{
      type: "plan",
      steps: [
        { text: "Inspect it", status: "completed" },
        { text: "Test it", status: "in-progress" },
        { text: "Ship it", status: "pending" },
      ],
    }])
    expect(mapAcpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Patch file",
      status: "completed",
      content: [{ type: "diff", path: "src/a.ts", oldText: "a", newText: "b" }],
    })).toEqual([
      { type: "tool", toolCallId: "tool-1", phase: "completed", title: "Patch file" },
      { type: "diff", diff: "--- src/a.ts\n+++ src/a.ts\n-a\n+b" },
    ])
    expect(mapAcpUpdate({
      sessionUpdate: "usage_update",
      used: 120,
      size: 10_000,
      cost: { amount: 0.03, currency: "USD" },
    })).toEqual([{
      type: "usage",
      used: 120,
      size: 10_000,
      cost: { amount: 0.03, currency: "USD" },
    }])
  })
})
