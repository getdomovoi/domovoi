import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import {
  CodexAppServerAdapter,
  StdioCodexTransport,
  codexPolicyFor,
  type CodexTransport,
  type JsonRpcMessage,
} from "./codex.js"

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  ignoreSignals = false
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal)
    if (this.ignoreSignals) return true
    queueMicrotask(() => {
      this.signalCode = signal
      this.emit("exit", null, signal)
      this.emit("close", null, signal)
    })
    return true
  }
}

class FakeTransport implements CodexTransport {
  readonly sent: JsonRpcMessage[] = []
  closeCount = 0
  closeGate: Promise<void> | undefined
  throwOnMethod: string | undefined
  #listener: ((message: JsonRpcMessage) => void) | undefined
  #errorListener: ((error: Error) => void) | undefined
  #staleListener: ((message: JsonRpcMessage) => void) | undefined
  #staleErrorListener: ((error: Error) => void) | undefined

  send(message: JsonRpcMessage): void {
    if (this.throwOnMethod && message.method === this.throwOnMethod) {
      throw new Error(`Failed to send ${message.method}`)
    }
    this.sent.push(message)
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listener = listener
    this.#staleListener = listener
    return () => {
      this.#listener = undefined
    }
  }

  receive(message: JsonRpcMessage): void {
    this.#listener?.(message)
  }

  receiveStale(message: JsonRpcMessage): void {
    this.#staleListener?.(message)
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListener = listener
    this.#staleErrorListener = listener
    return () => { this.#errorListener = undefined }
  }

  fail(error: Error): void {
    this.#errorListener?.(error)
  }

  failStale(error: Error): void {
    this.#staleErrorListener?.(error)
  }

  async close(): Promise<void> {
    this.closeCount += 1
    await this.closeGate
  }
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
    [runtime("ask", false), "on-request", "readOnly"],
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

describe("StdioCodexTransport", () => {
  it("drains child stderr to prevent pipe backpressure", () => {
    const child = new FakeChild()

    new StdioCodexTransport(() => child as unknown as ChildProcessWithoutNullStreams)

    expect(child.stderr.readableFlowing).toBe(true)
  })

  it("reports an unexpected child exit once", () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.emit("exit", 1, null)
    child.emit("error", new Error("late process error"))

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: "Codex app-server exited with code 1",
    }))
  })

  it("does not report an intentional child exit", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    await transport.close()

    expect(error).not.toHaveBeenCalled()
  })

  it("escalates a stuck close and resolves after the grace period", async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      child.ignoreSignals = true
      const transport = new StdioCodexTransport(
        () => child as unknown as ChildProcessWithoutNullStreams,
        25,
      )

      const closing = transport.close()
      expect(child.signals).toEqual(["SIGTERM"])
      await vi.advanceTimersByTimeAsync(25)

      await expect(closing).resolves.toBeUndefined()
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("CodexAppServerAdapter permissions", () => {
  it("declares read-only Ask and rejects unenforceable Build-auto", () => {
    expect(new CodexAppServerAdapter(() => new FakeTransport()).permissionCapabilities).toEqual({
      ask: "read-only",
      buildAuto: "unsupported",
    })
  })
})

describe("CodexAppServerAdapter", () => {
  it("resets timed-out initialization without reviving the stale transport", async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)

    const staleConnection = adapter.connect()
    await adapter.resetConnection()
    await expect(staleConnection).rejects.toThrow("Codex connection reset")
    expect(first.closeCount).toBe(1)

    const freshConnection = adapter.connect()
    first.receiveStale({ id: 1, result: {} })
    expect(first.sent).not.toContainEqual(expect.objectContaining({ method: "initialized" }))
    second.receive({ id: 2, result: {} })
    await expect(freshConnection).resolves.toBeUndefined()
    expect(second.sent).toContainEqual(expect.objectContaining({ method: "initialized" }))
    await adapter.close()
  })

  it("rejects in-flight work and reconnects after transport loss", async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    first.receive({ id: 1, result: {} })
    await connecting

    const interrupted = adapter.startTurn({
      threadId: "thread-recover",
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build", false),
    })
    first.fail(new Error("Codex app-server exited with code 1"))

    await expect(interrupted).rejects.toThrow("Codex app-server exited with code 1")
    expect(event).toHaveBeenCalledWith({
      type: "provider-disconnected",
      reason: "Codex app-server exited with code 1",
    })

    const reconnecting = adapter.connect()
    expect(second.sent[0]).toMatchObject({ id: 3, method: "initialize" })
    second.receive({ id: 3, result: {} })
    await reconnecting
    const resuming = adapter.resumeThread({
      threadId: "thread-recover",
      cwd: "/worktree",
      runtime: runtime("build", false),
    })
    expect(second.sent.at(-1)).toMatchObject({
      id: 4,
      method: "thread/resume",
      params: { threadId: "thread-recover" },
    })
    second.receive({ id: 4, result: { thread: { id: "thread-recover" } } })
    await resuming

    event.mockClear()
    first.receiveStale({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-recover", turnId: "turn-old", delta: "stale" },
    })
    first.failStale(new Error("late stale failure"))
    expect(event).not.toHaveBeenCalled()

    await adapter.close()
  })

  it("shares initialization across concurrent connect calls", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)

    const first = adapter.connect()
    const second = adapter.connect()
    let secondSettled = false
    void second.finally(() => { secondSettled = true })
    await Promise.resolve()

    expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(1)
    expect(secondSettled).toBe(false)
    transport.receive({ id: 1, result: {} })
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    await adapter.close()
  })

  it("rejects every pending request and reports transport loss once", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    const failure = new Error("Codex transport failed")
    transport.fail(failure)
    transport.fail(failure)

    await expect(listing).rejects.toThrow("Codex transport failed")
    await expect(starting).rejects.toThrow("Codex transport failed")
    expect(event).toHaveBeenCalledTimes(1)
    expect(event).toHaveBeenCalledWith({
      type: "provider-disconnected",
      reason: "Codex transport failed",
    })
    expect(transport.closeCount).toBe(1)
  })

  it("cleans up a failed initialization and permits another connect", async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)
    adapter.onEvent(event)

    const failedConnect = adapter.connect()
    first.receive({ id: 1, error: { message: "Unsupported protocol" } })
    await expect(failedConnect).rejects.toThrow("Unsupported protocol")
    expect(first.closeCount).toBe(1)
    expect(event).not.toHaveBeenCalled()

    const reconnecting = adapter.connect()
    expect(second.sent[0]).toMatchObject({ id: 2, method: "initialize" })
    second.receive({ id: 2, result: {} })
    await expect(reconnecting).resolves.toBeUndefined()
    await adapter.close()
  })

  it("cleans up when the initialized notification cannot be sent", async () => {
    const first = new FakeTransport()
    first.throwOnMethod = "initialized"
    const second = new FakeTransport()
    const transports = [first, second]
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)
    adapter.onEvent(event)

    const failedConnect = adapter.connect()
    first.receive({ id: 1, result: {} })
    await expect(failedConnect).rejects.toThrow("Failed to send initialized")
    expect(first.closeCount).toBe(1)
    expect(event).not.toHaveBeenCalled()

    const reconnecting = adapter.connect()
    second.receive({ id: 2, result: {} })
    await expect(reconnecting).resolves.toBeUndefined()
    await adapter.close()
  })

  it("detaches and rejects initialization before waiting for close", async () => {
    const transport = new FakeTransport()
    let releaseClose!: () => void
    transport.closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)

    const connecting = adapter.connect()
    const closing = adapter.close()

    await expect(connecting).rejects.toThrow("Codex adapter closed")
    expect(event).not.toHaveBeenCalled()
    transport.failStale(new Error("late failure while closing"))
    expect(event).not.toHaveBeenCalled()
    releaseClose()
    await expect(closing).resolves.toBeUndefined()
  })

  it("does not report intentional close as transport loss", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const pending = adapter.listModels()
    await adapter.close()

    await expect(pending).rejects.toThrow("Codex adapter closed")
    expect(event).not.toHaveBeenCalled()
    expect(transport.closeCount).toBe(1)
  })

  it("resumes a persisted thread before another turn", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const resuming = adapter.resumeThread({
      threadId: "thread-restored",
      cwd: "/worktree",
      runtime: runtime("build", false),
    })
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "thread/resume",
      params: { threadId: "thread-restored" },
    })
    transport.receive({ id: 2, result: { thread: { id: "thread-restored" } } })
    await expect(resuming).resolves.toBeUndefined()
    await adapter.close()
  })

  it("lists visible models from the installed Codex app server", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "model/list",
      params: { includeHidden: false, limit: 100 },
    })
    transport.receive({
      id: 2,
      result: {
        data: [{
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Coding model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "none", description: "No reasoning" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "xhigh", description: "Deeper" },
            { reasoningEffort: "max", description: "Maximum" },
          ],
          defaultReasoningEffort: "xhigh",
          isDefault: true,
        }],
        nextCursor: null,
      },
    })

    await expect(listing).resolves.toEqual([{
      provider: "codex",
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Coding model",
      supportedReasoningEfforts: ["none", "medium", "xhigh", "max"],
      defaultReasoningEffort: "xhigh",
      isDefault: true,
    }])
    await adapter.close()
  })

  it("normalizes reasoning defaults and stops repeated pagination cursors", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    transport.receive({
      id: 2,
      result: {
        data: [{
          model: "model-a",
          supportedReasoningEfforts: [
            { reasoningEffort: " low " },
            { reasoningEffort: "   " },
          ],
          defaultReasoningEffort: " high ",
        }],
        nextCursor: "repeat",
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.sent.at(-1)).toMatchObject({
      id: 3,
      method: "model/list",
      params: { cursor: "repeat" },
    })
    transport.receive({
      id: 3,
      result: { data: [], nextCursor: "repeat" },
    })

    await expect(listing).resolves.toEqual([
      expect.objectContaining({
        id: "model-a",
        displayName: "model-a",
        supportedReasoningEfforts: ["high", "low"],
        defaultReasoningEffort: "high",
      }),
    ])
    expect(transport.sent.filter((message) => message.method === "model/list")).toHaveLength(2)
    await adapter.close()
  })

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

    const steering = adapter.steerTurn("thread-1", "turn-1", "Focus on the failing test")
    expect(transport.sent[5]).toMatchObject({
      id: 5,
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Focus on the failing test" }],
      },
    })
    transport.receive({ id: 5, result: { turnId: "turn-1" } })
    await expect(steering).resolves.toBeUndefined()

    const interrupting = adapter.interruptTurn("thread-1", "turn-1")
    expect(transport.sent[6]).toMatchObject({
      id: 6,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    })
    transport.receive({ id: 6, result: {} })
    await expect(interrupting).resolves.toBeUndefined()

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
