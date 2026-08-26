import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import {
  CodexAppServerAdapter,
  codexPolicyFor,
  type CodexTransport,
  type JsonRpcMessage,
} from "./codex.js"

class FakeTransport implements CodexTransport {
  readonly sent: JsonRpcMessage[] = []
  #listener: ((message: JsonRpcMessage) => void) | undefined

  send(message: JsonRpcMessage): void {
    this.sent.push(message)
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listener = listener
    return () => {
      this.#listener = undefined
    }
  }

  receive(message: JsonRpcMessage): void {
    this.#listener?.(message)
  }

  async close(): Promise<void> {}
}

const runtime = (permissionMode: Runtime["permissionMode"], auto: boolean): Runtime => ({
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  permissionMode,
  auto,
})

describe("codexPolicyFor", () => {
  it.each([
    [runtime("ask", false), "on-request", "workspaceWrite"],
    [runtime("plan", false), "never", "readOnly"],
    [runtime("build", false), "on-request", "workspaceWrite"],
    [runtime("build", true), "never", "workspaceWrite"],
  ] as const)("maps Domovoi runtime to Codex enforcement", (input, approvalPolicy, sandboxType) => {
    expect(codexPolicyFor(input, "/worktree")).toMatchObject({
      approvalPolicy,
      sandboxPolicy: { type: sandboxType },
    })
  })
})

describe("CodexAppServerAdapter", () => {
  it("translates plan mode to the Codex read-only sandbox", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)

    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("plan", false) })
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "thread/start",
      params: { sandbox: "read-only" },
    })
    transport.receive({ id: 2, result: { thread: { id: "thread-plan" } } })
    await expect(starting).resolves.toBe("thread-plan")
    await adapter.close()
  })

  it("initializes, starts a turn, streams events, and resolves approval", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)

    const connecting = adapter.connect()
    expect(transport.sent[0]).toMatchObject({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "domovoi", title: "Domovoi", version: "0.0.1" } },
    })
    transport.receive({ id: 1, result: {} })
    await connecting
    expect(transport.sent[1]).toEqual({ method: "initialized", params: {} })

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/worktree",
        model: "gpt-5.6-sol",
        sandbox: "workspace-write",
        serviceName: "domovoi",
      },
    })
    transport.receive({ id: 2, result: { thread: { id: "thread-1" } } })
    await expect(starting).resolves.toBe("thread-1")

    const stopping = adapter.stopThread("thread-old")
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "thread/archive",
      params: { threadId: "thread-old" },
    })
    transport.receive({ id: 3, result: {} })
    await expect(stopping).resolves.toBeUndefined()

    const turning = adapter.startTurn({
      threadId: "thread-1",
      cwd: "/worktree",
      prompt: "Run the tests",
      runtime: runtime("build", false),
    })
    expect(transport.sent[4]).toMatchObject({
      id: 4,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Run the tests" }],
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/worktree"] },
      },
    })
    transport.receive({ id: 4, result: { turn: { id: "turn-1" } } })
    await expect(turning).resolves.toBe("turn-1")

    transport.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "Tests are running." },
    })
    transport.receive({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "pnpm test",
        cwd: "/worktree",
        reason: "Run project tests",
      },
    })
    expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "text-delta",
      delta: "Tests are running.",
    }))
    expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval-requested",
      requestId: 41,
      command: "pnpm test",
    }))

    adapter.resolveApproval(41, "always-project")
    expect(transport.sent.at(-1)).toEqual({ id: 41, result: { decision: "acceptForSession" } })
    await adapter.close()
  })
})
