import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { describe, expect, it, vi } from "vitest"

import { AcpAgentAdapter } from "./acp.js"
import { CURSOR_ACP_PROVIDER } from "./acp-providers.js"
import { mapAcpSessionSetup, mapAcpUpdate, StdioAcpPeer } from "./acp-stdio.js"
import { classifyProviderFailure } from "./provider-failures.js"

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

    expect(onDisconnect).toHaveBeenCalledOnce()
    const reason = String(onDisconnect.mock.calls[0]?.[0])
    expect(reason).toContain("cursor-agent exited with code 1")
    expect(reason).toContain("401 token expired")
    expect(classifyProviderFailure(new Error(reason)).kind).toBe("authentication-expired")
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
