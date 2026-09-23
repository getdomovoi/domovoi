import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

vi.mock("@getdomovoi/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@getdomovoi/protocol")>(),
  buildVersion: "9.8.7-test",
}))

import {
  CodexAppServerAdapter,
  StdioCodexTransport,
  codexAppServerArguments,
  codexDeveloperInstructions,
  codexPolicyFor,
  codexSecretLocations,
  codexWorktreeSecretPatterns,
  type CodexTransport,
  type JsonRpcMessage,
} from "./codex.js"
import { classifyProviderFailure } from "./provider-failures.js"

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
    [runtime("ask", false), "on-request", "domovoi-read"],
    [runtime("plan", false), "never", "domovoi-read"],
    [runtime("build", false), "on-request", "domovoi-build"],
    [runtime("build", true), "never", "domovoi-build"],
  ] as const)("maps Domovoi runtime to Codex enforcement", (input, approvalPolicy, permissions) => {
    const policy = codexPolicyFor(input)
    expect(policy).toEqual({ approvalPolicy, permissions })
  })
})

describe("codexAppServerArguments", () => {
  const settings = new Map<string, string>()
  const argumentsList = codexAppServerArguments()
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] !== "-c") continue
    const setting = argumentsList[index + 1]!
    const separator = setting.indexOf("=")
    settings.set(setting.slice(0, separator), setting.slice(separator + 1))
  }

  it("serves stdio and defines the two profiles Domovoi selects per turn", () => {
    expect(argumentsList.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"])
    expect(settings.get("permissions.domovoi-read.extends")).toBe('":read-only"')
    expect(settings.get("permissions.domovoi-build.extends")).toBe('":workspace"')
    expect(settings.get("permissions.domovoi-read.network.enabled")).toBe("false")
    expect(settings.get("permissions.domovoi-build.network.enabled")).toBe("false")
  })

  it("denies secret files inside the worktree in both profiles", () => {
    for (const profile of ["domovoi-read", "domovoi-build"]) {
      const filesystem = settings.get(`permissions.${profile}.filesystem`)!
      for (const pattern of ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/.npmrc", "**/.netrc", "**/.pypirc"]) {
        expect(filesystem).toContain(`${JSON.stringify(pattern)}="deny"`)
      }
      expect(filesystem).toContain('":workspace_roots"={')
    }
    expect(codexWorktreeSecretPatterns).toContain("**/.env")
  })

  it.each([
    "~/.ssh", "~/.aws", "~/.domovoi", "~/.config/gh", "~/.kube", "~/.docker", "~/.netrc", "~/.gnupg",
  ])("denies reads of %s in both profiles", (location) => {
    for (const profile of ["domovoi-read", "domovoi-build"]) {
      expect(settings.get(`permissions.${profile}.filesystem`)).toContain(`${JSON.stringify(location)}="deny"`)
    }
    expect(codexSecretLocations).toContain(location)
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

  it("carries the child's final stderr into the exit error", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.stderr.write("token=super-secret\nNot logged in\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", 1, null)

    expect(error).toHaveBeenCalledTimes(1)
    const message = (error.mock.calls[0]?.[0] as Error).message
    expect(message).toBe("Codex app-server exited with code 1: token=[REDACTED]\nNot logged in")
    expect(classifyProviderFailure(new Error(message)).kind).toBe("authentication-expired")
  })

  it("keeps only the last 16 KiB of stderr in the exit error", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.stderr.write(`${"x".repeat(20_000)}\n`)
    child.stderr.write("Not logged in\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", null, "SIGABRT")

    const message = (error.mock.calls[0]?.[0] as Error).message
    expect(message.startsWith("Codex app-server exited from signal SIGABRT: ")).toBe(true)
    expect(message.endsWith("Not logged in")).toBe(true)
    expect(message.length).toBeLessThanOrEqual(16_384 + "Codex app-server exited from signal SIGABRT: ".length)
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

  it("narrows app-server lines to JSON-RPC messages and rejects non-object lines", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const message = vi.fn()
    const error = vi.fn()
    transport.onMessage(message)
    transport.onError(error)

    child.stdout.write(`${JSON.stringify({
      id: 2,
      method: 5,
      params: "not-an-object",
      result: { ok: true },
    })}\n`)
    child.stdout.write("[]\n")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(message).toHaveBeenCalledTimes(1)
    expect(message).toHaveBeenCalledWith({ id: 2, result: { ok: true } })
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: "Codex app-server emitted invalid JSONL",
    }))
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
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
      // A child that outlives its kill still bounds the close.
      await vi.advanceTimersByTimeAsync(25)

      await expect(closing).resolves.toBeUndefined()
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports the close only once the killed child has exited", async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      child.ignoreSignals = true
      const transport = new StdioCodexTransport(
        () => child as unknown as ChildProcessWithoutNullStreams,
        25,
      )
      const settled = vi.fn()

      const closing = transport.close().then(settled)
      await vi.advanceTimersByTimeAsync(25)

      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(settled).not.toHaveBeenCalled()

      child.signalCode = "SIGKILL"
      child.emit("exit", null, "SIGKILL")
      child.emit("close", null, "SIGKILL")
      await closing

      expect(settled).toHaveBeenCalledOnce()
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
  it("initializes without experimental APIs when capability negotiation is unavailable", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()

    transport.receive({ id: 1, error: { message: "unknown capability experimentalApi" } })
    await Promise.resolve()
    expect(transport.sent[1]).toMatchObject({
      id: 2,
      method: "initialize",
      params: { clientInfo: { name: "domovoi", title: "Domovoi", version: "9.8.7-test" } },
    })
    expect(transport.sent[1]?.params).not.toHaveProperty("capabilities")
    transport.receive({ id: 2, result: {} })

    await expect(connecting).resolves.toBeUndefined()
    expect(transport.sent[2]).toEqual({ method: "initialized", params: {} })
    await adapter.close()
  })

  it("reads provider-reported primary and secondary quota windows", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const reading = adapter.usageLimits()
    expect(transport.sent.at(-1)).toEqual({
      id: 2,
      method: "account/rateLimits/read",
      params: { excludeResetCreditDetails: true },
    })
    transport.receive({
      id: 2,
      result: {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_758_405_600 },
          secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 1_758_751_200 },
        },
      },
    })

    await expect(reading).resolves.toEqual({
      provider: "codex",
      planType: "plus",
      windows: [
        { kind: "primary", usedPercent: 23, windowDurationMinutes: 300, resetsAt: "2025-09-20T22:00:00.000Z" },
        { kind: "secondary", usedPercent: 41, windowDurationMinutes: 10_080, resetsAt: "2025-09-24T22:00:00.000Z" },
      ],
    })
    await adapter.close()
  })

  it("omits absent or malformed quota windows", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const reading = adapter.usageLimits()
    transport.receive({
      id: 2,
      result: {
        rateLimits: {
          planType: "plus",
          primary: null,
          secondary: { usedPercent: -1, windowDurationMins: 10_080, resetsAt: 1_758_751_200 },
        },
      },
    })

    await expect(reading).resolves.toBeUndefined()
    await adapter.close()
  })

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

  it("cancels discovery without closing a shared transport or following a late page", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting
    const controller = new AbortController()
    const listing = adapter.listModels(controller.signal)
    controller.abort(new Error("Discovery expired"))
    await expect(listing).rejects.toThrow("Discovery expired")
    transport.receive({ id: 2, result: { data: [], nextCursor: "late-page" } })
    expect(transport.sent.filter(({ method }) => method === "model/list")).toHaveLength(1)
    expect(transport.closeCount).toBe(0)
    const retry = adapter.listModels()
    transport.receive({ id: 3, result: { data: [], nextCursor: null } })
    await expect(retry).resolves.toEqual([])
    await adapter.close()
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

  it("skips malformed model rows instead of failing the whole listing", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    transport.receive({
      id: 2,
      result: {
        data: [
          { model: 5, displayName: "Numeric id" },
          { model: "bad-display", displayName: 7 },
          { model: "bad-effort", defaultReasoningEffort: 3 },
          { model: "bad-efforts", supportedReasoningEfforts: [null] },
          { model: "bad-flag", isDefault: "yes" },
          {
            model: "good",
            displayName: "Good",
            description: "Kept",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            defaultReasoningEffort: "high",
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    })

    await expect(listing).resolves.toEqual([{
      provider: "codex",
      id: "good",
      displayName: "Good",
      description: "Kept",
      supportedReasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
      isDefault: false,
    }])
    await adapter.close()
  })

  it("rejects thread and turn results without string identifiers", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined())
    transport.receive({ id: 3, result: { thread: { id: 7 } } })
    await expect(starting).rejects.toThrow("Codex did not return a thread id")

    const turning = adapter.startTurn({
      threadId: "thread-1",
      cwd: "/worktree",
      prompt: "Run the tests",
      runtime: runtime("build", false),
    })
    transport.receive({ id: 4, result: { turn: { id: ["turn-1"] } } })
    await expect(turning).rejects.toThrow("Codex did not return a turn id")

    const resuming = adapter.resumeThread({
      threadId: "7",
      cwd: "/worktree",
      runtime: runtime("build", false),
    })
    transport.receive({ id: 5, result: null })
    await expect(resuming).rejects.toThrow("Codex did not resume the requested thread")

    const steering = adapter.steerTurn("thread-1", "turn-1", "Focus on the failing test")
    transport.receive({ id: 6, result: "turn-1" })
    await expect(steering).rejects.toThrow("Codex steered a different turn")
    await adapter.close()
  })

  it("translates plan mode to the Codex read-only sandbox", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)

    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("plan", false) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined())
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "thread/start",
      params: { sandbox: "read-only" },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-plan" } } })
    await expect(starting).resolves.toBe("thread-plan")
    await adapter.close()
  })

  it.each([
    ["the person's own instructions", "Always answer in French.", "Always answer in French.\n\n"],
    ["no instructions of their own", null, ""],
  ] as const)("adds Domovoi's text to %s, read from Codex's resolved config for the worktree", async (_label, own, prefix) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    expect(transport.sent[2]).toEqual({ id: 2, method: "config/read", params: { cwd: "/worktree" } })
    transport.receive({ id: 2, result: { config: { developer_instructions: own }, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined())
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "thread/start",
      params: { developerInstructions: `${prefix}${codexDeveloperInstructions}` },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-own" } } })
    await expect(starting).resolves.toBe("thread-own")
    await adapter.close()
  })

  it("does not start a Codex thread without the person's own instructions when they cannot be read", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    transport.receive({ id: 2, error: { code: -32600, message: "config read failed" } })
    await expect(starting).rejects.toThrow("config read failed")
    expect(transport.sent.map((message) => message.method)).not.toContain("thread/start")
    await adapter.close()
  })

  it.each([
    ["ask", false],
    ["plan", false],
    ["build", false],
    ["build", true],
  ] as const)("tells a new %s Codex thread which worktree files its sandbox refuses", async (mode, auto) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)

    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime(mode, auto) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined())
    const instructions = (transport.sent[3]?.params as { developerInstructions?: unknown } | undefined)
      ?.developerInstructions
    expect(typeof instructions).toBe("string")
    for (const file of [".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".npmrc", ".netrc", ".pypirc"]) {
      expect(instructions).toContain(file)
    }
    expect(instructions).toContain("Operation not permitted")
    expect(instructions).toMatch(/say so in your reply/)
    transport.receive({ id: 3, result: { thread: { id: "thread-notice" } } })
    await expect(starting).resolves.toBe("thread-notice")
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
      params: {
        clientInfo: { name: "domovoi", title: "Domovoi", version: "9.8.7-test" },
        capabilities: { experimentalApi: true },
      },
    })
    transport.receive({ id: 1, result: {} })
    await connecting
    expect(transport.sent[1]).toEqual({ method: "initialized", params: {} })

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    expect(transport.sent[2]).toEqual({ id: 2, method: "config/read", params: { cwd: "/worktree" } })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined())
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "thread/start",
      params: {
        cwd: "/worktree",
        model: "gpt-5.6-sol",
        sandbox: "workspace-write",
        serviceName: "domovoi",
      },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-1" } } })
    await expect(starting).resolves.toBe("thread-1")

    const stopping = adapter.stopThread("thread-old")
    expect(transport.sent[4]).toMatchObject({
      id: 4,
      method: "thread/archive",
      params: { threadId: "thread-old" },
    })
    transport.receive({ id: 4, result: {} })
    await expect(stopping).resolves.toBeUndefined()

    const turning = adapter.startTurn({
      threadId: "thread-1",
      cwd: "/worktree",
      prompt: "Run the tests",
      runtime: runtime("build", false),
    })
    expect(transport.sent[5]).toMatchObject({
      id: 5,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Run the tests" }],
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.6-sol",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
        approvalPolicy: "on-request",
        permissions: "domovoi-build",
      },
    })
    expect(transport.sent[5]?.params).not.toHaveProperty("sandboxPolicy")
    transport.receive({ id: 5, result: { turn: { id: "turn-1" } } })
    await expect(turning).resolves.toBe("turn-1")

    const steering = adapter.steerTurn("thread-1", "turn-1", "Focus on the failing test")
    expect(transport.sent[6]).toMatchObject({
      id: 6,
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Focus on the failing test" }],
      },
    })
    transport.receive({ id: 6, result: { turnId: "turn-1" } })
    await expect(steering).resolves.toBeUndefined()

    const interrupting = adapter.interruptTurn("thread-1", "turn-1")
    expect(transport.sent[7]).toMatchObject({
      id: 7,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    })
    transport.receive({ id: 7, result: {} })
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
    expect(transport.sent.at(-1)).toEqual({ id: 41, result: { decision: "accept" } })
    await adapter.close()
  })

  it("starts Plan turns in Codex's native plan collaboration mode", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const turning = adapter.startTurn({
      threadId: "thread-plan",
      cwd: "/worktree",
      prompt: "Plan the work",
      runtime: runtime("plan", false),
    })
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "turn/start",
      params: {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.6-sol",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
      },
    })
    transport.receive({ id: 2, result: { turn: { id: "turn-plan" } } })
    await expect(turning).resolves.toBe("turn-plan")
    await adapter.close()
  })

  it("falls back to a plain Plan turn when collaboration mode is unavailable", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const turning = adapter.startTurn({
      threadId: "thread-plan-fallback",
      cwd: "/worktree",
      prompt: "Plan the work",
      runtime: runtime("plan", false),
    })
    transport.receive({
      id: 2,
      error: { message: "turn/start.collaborationMode requires experimentalApi capability" },
    })
    await Promise.resolve()
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread-plan-fallback",
        input: [{ type: "text", text: "Plan the work" }],
      },
    })
    expect(transport.sent[3]?.params).not.toHaveProperty("collaborationMode")
    transport.receive({ id: 3, result: { turn: { id: "turn-plan-fallback" } } })
    await expect(turning).resolves.toBe("turn-plan-fallback")
    await adapter.close()
  })

  it("emits full structured plans from Codex plan updates", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "I will verify before changing code.",
        plan: [
          { step: "Inspect the failing test", status: "completed" },
          { step: "Implement the fix", status: "inProgress" },
          { step: "Run verification", status: "pending" },
        ],
      },
    })

    expect(event).toHaveBeenCalledWith({
      type: "plan-updated",
      threadId: "thread-1",
      turnId: "turn-1",
      steps: [
        { text: "Inspect the failing test", status: "completed" },
        { text: "Implement the fix", status: "in-progress" },
        { text: "Run verification", status: "pending" },
      ],
    })
    await adapter.close()
  })

  it("emits current context from Codex token-usage notifications", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 510_000,
            inputTokens: 480_000,
            cachedInputTokens: 300_000,
            outputTokens: 30_000,
            reasoningOutputTokens: 20_000,
          },
          last: {
            totalTokens: 128_000,
            inputTokens: 120_000,
            cachedInputTokens: 90_000,
            outputTokens: 8_000,
            reasoningOutputTokens: 5_000,
          },
          modelContextWindow: 200_000,
        },
      },
    })

    expect(event).toHaveBeenCalledWith({
      type: "usage",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 120_000,
        cachedInputTokens: 90_000,
        outputTokens: 3_000,
        reasoningTokens: 5_000,
        totalTokens: 128_000,
        contextTokens: 128_000,
        contextWindowTokens: 200_000,
        costSource: "unavailable",
      },
    })
    await adapter.close()
  })

  it("carries the provider item id on an agent message delta", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "first" },
    })
    transport.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-2", delta: "second" },
    })

    expect(event).toHaveBeenNthCalledWith(1, {
      type: "text-delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "first",
    })
    expect(event).toHaveBeenNthCalledWith(2, {
      type: "text-delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-2",
      delta: "second",
    })

    await adapter.close()
  })
})
