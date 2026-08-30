import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { describe, expect, it, vi } from "vitest"

import { CURSOR_ACP_PROVIDER } from "./acp-providers.js"
import { mapAcpSessionSetup, mapAcpUpdate, StdioAcpPeer } from "./acp-stdio.js"

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
    const newline = input.indexOf("\n")
    if (newline === -1) return
    const request = JSON.parse(input.slice(0, newline)) as { id: number }
    child.stdout.write(`${JSON.stringify(response(request.id))}\n`)
  })
  child.kill.mockImplementation(() => {
    child.emit("exit", 1, null)
    return true
  })
  return child
}

describe("ACP stdio mapping", () => {
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
      entries: [{ content: "Test it", priority: "high", status: "in_progress" }],
    })).toEqual([{ type: "plan", text: "- [~] Test it" }])
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
