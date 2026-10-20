import { afterEach, describe, expect, it, vi } from "vitest"
import type { Runtime } from "@getdomovoi/protocol"
import { CodexAppServerAdapter, type AgentEvent, type CodexTransport, type JsonRpcMessage } from "./codex.js"
import { codexUsageCaptures } from "./codex-usage-fixtures.js"
import { UsageLedger } from "./usage.js"

const runtime: Runtime = { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", permissionMode: "ask", auto: false }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

class Transport implements CodexTransport {
  sent: JsonRpcMessage[] = []
  listener: ((message: JsonRpcMessage) => void) | undefined
  error: ((error: Error) => void) | undefined
  nextTurn = "turn-1"
  rejectRaw = false
  rejectOptOut = false
  startError: JsonRpcMessage["error"]
  beforeTurnReply: (() => void) | undefined
  send(message: JsonRpcMessage): void {
    this.sent.push(message)
    if (message.id === undefined || !message.method) return
    if (message.method === "initialize" && this.rejectOptOut
      && (message.params?.capabilities as Record<string, unknown> | undefined)?.optOutNotificationMethods) {
      this.receive({ id: message.id, error: { code: -32602, message: "unknown field `optOutNotificationMethods`" } })
      return
    }
    if (message.method === "thread/start" && (this.startError || (this.rejectRaw && message.params?.experimentalRawEvents))) {
      this.receive({ id: message.id, error: this.startError ?? { code: -32602, message: "unknown field `experimentalRawEvents`" } })
      return
    }
    if (message.method === "turn/start") {
      this.receive({ method: "turn/started", params: { threadId: message.params?.threadId, turn: { id: this.nextTurn } } })
      this.beforeTurnReply?.()
    }
    this.receive({ id: message.id, result: message.method === "config/read" ? { config: {} }
      : message.method.startsWith("thread/") ? { thread: { id: "thread-1" } }
        : message.method === "turn/start" ? { turn: { id: this.nextTurn } } : {} })
  }
  onMessage(listener: (message: JsonRpcMessage) => void): () => void { this.listener = listener; return () => { this.listener = undefined } }
  onError(listener: (error: Error) => void): () => void { this.error = listener; return () => { this.error = undefined } }
  receive(message: JsonRpcMessage): void { this.listener?.(structuredClone(message)) }
  async close(): Promise<void> {}
}

async function setup(options: { resume?: boolean; rejectRaw?: boolean; rejectOptOut?: boolean } = {}) {
  const transport = new Transport()
  transport.rejectRaw = options.rejectRaw ?? false
  transport.rejectOptOut = options.rejectOptOut ?? false
  const adapter = new CodexAppServerAdapter(() => transport)
  const ledger = new UsageLedger()
  const events: AgentEvent[] = []
  const dispatches = new Map<string, { sessionId: string; provider: string; model: string; threadId: string; turnId: string }>()
  adapter.onEvent((event) => {
    events.push(event)
    if (event.type === "usage") {
      const dispatch = dispatches.get(event.turnId ?? "")
      if (dispatch && event.threadId === dispatch.threadId) ledger.observe(dispatch, event)
    }
    if (event.type === "turn-completed") {
      const turn = event.params.turn as { id: string; status: string }
      const dispatch = dispatches.get(turn.id)
      if (dispatch && event.params.threadId === dispatch.threadId) ledger.finish(dispatch, turn.status === "completed" ? "completed" : "interrupted")
    }
    if (event.type === "provider-disconnected") for (const dispatch of dispatches.values()) ledger.finish(dispatch, "interrupted")
  })
  cleanups.push(async () => { await adapter.close(); ledger.close() })
  await adapter.connect()
  if (options.resume) await adapter.resumeThread({ threadId: "thread-1", cwd: "/worktree", runtime })
  else await adapter.startThread({ cwd: "/worktree", runtime })
  const start = async (turnId = "turn-1") => {
    const dispatch = { sessionId: "session", provider: "codex", model: runtime.model, threadId: "thread-1", turnId }
    dispatches.set(turnId, dispatch)
    ledger.begin(dispatch)
    transport.nextTurn = turnId
    await adapter.startTurn({ threadId: "thread-1", cwd: "/worktree", runtime, prompt: "capture" })
  }
  const replay = async (name: string) => {
    for (const message of codexUsageCaptures[name]!) {
      if (message.method === "turn/started" && message.params?.threadId === "thread-1") {
        await start((message.params.turn as { id: string }).id)
      }
      transport.receive(message)
    }
  }
  return { transport, adapter, ledger, events, start, replay }
}

const receipt = (responseId = "response-1", usage: unknown = {
  inputTokens: 100, cachedInputTokens: 10, cacheWriteInputTokens: 0,
  outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120,
}): JsonRpcMessage => ({ method: "rawResponse/completed", params: { threadId: "thread-1", turnId: "turn-1", responseId, usage } })
const snapshot = (scale = 1): JsonRpcMessage => ({
  method: "thread/tokenUsage/updated",
  params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: {
    last: { inputTokens: 100 * scale, cachedInputTokens: 10 * scale, outputTokens: 20 * scale, reasoningOutputTokens: 5 * scale, totalTokens: 120 * scale },
    total: { totalTokens: 999_999 }, modelContextWindow: 258_400,
  } },
})
const completed = (): JsonRpcMessage => ({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })
const reported = (events: AgentEvent[]) => events.filter((event) => event.type === "usage" && event.source?.tokens === "reported")

describe("Codex receipt accounting", () => {
  it.each([
    ["multi", 720, 2], ["overflow", 360, 1], ["interrupt-after", 360, 1],
    ["interrupt-final", 360, 1], ["auto", 720, 1], ["manual", 360, 2],
    ["overflow-auto", 960, 1], ["subagent", 360, 1],
    ["stream-drop", 240, 1], ["failed-retry", 240, 1], ["http-retry", 240, 1],
    ["raw-optout", 120, 1],
  ] as const)("replays %s with every observed receipt and partial coverage", async (name, totalTokens, turns) => {
    const h = await setup()
    await h.replay(name)
    expect(h.ledger.session("session")).toMatchObject({ totalTokens, byRuntime: [{ turns }], coverage: { complete: 0, partial: turns, pending: 0 } })
    expect(h.events.filter((event) => event.type === "usage")).not.toContainEqual(expect.objectContaining({ source: expect.objectContaining({ final: true }) }))
  })

  it.each(["interrupt-before", "missing-usage"])("keeps %s unavailable", async (name) => {
    const h = await setup()
    await h.replay(name)
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 0, coverage: { unavailable: 1, complete: 0 } })
  })

  it("keeps receipts on transport loss", async () => {
    const h = await setup()
    await h.replay("crash")
    h.transport.error?.(new Error("capture ended"))
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 120, coverage: { partial: 1 } })
  })

  it.each([{ resume: true }, { rejectRaw: true }])("reports fallback-only usage live: %j", async (options) => {
    const h = await setup(options)
    await h.start()
    h.transport.receive(snapshot(2))
    h.transport.receive(snapshot())
    expect(h.ledger.session("session").totalTokens).toBe(240)
    expect(reported(h.events).at(-1)).toMatchObject({ usage: { totalTokens: 240, contextTokens: 120 } })
    h.transport.error?.(new Error("lost"))
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 240, coverage: { partial: 1 } })
  })

  it.each(["resume", "resume-crash"])("ignores pre-dispatch history on %s", async (name) => {
    const h = await setup({ resume: true })
    await h.replay(name)
    h.transport.error?.(new Error("lost"))
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 120, byRuntime: [{ turns: 1 }], coverage: { partial: 1 } })
  })

  it.each(["terminal", "loss", "reset"])("flushes buffered fallback without receipts on %s", async (end) => {
    const h = await setup()
    await h.start()
    h.transport.receive(snapshot(2))
    expect(reported(h.events)).toHaveLength(0)
    if (end === "terminal") h.transport.receive(completed())
    else if (end === "reset") await h.adapter.resetConnection()
    else h.transport.error?.(new Error("lost"))
    expect(h.ledger.session("session").totalTokens).toBe(240)
  })

  it("replaces context-only snapshots with the smaller receipt sum", async () => {
    const h = await setup()
    await h.start()
    h.transport.receive(snapshot(10))
    h.transport.receive(receipt())
    h.transport.receive(receipt("response-2"))
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 240, inputTokens: 200, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 10, coverage: { partial: 1 } })
  })

  it("does not end or seal the parent when the child completes first", async () => {
    const h = await setup()
    await h.start()
    const child = codexUsageCaptures.subagent!.filter((m) => m.params?.threadId === "thread-2")
    h.transport.receive(receipt())
    for (const message of child) h.transport.receive(message)
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 120, coverage: { pending: 1 } })
    h.transport.receive(receipt("response-2"))
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 240, byRuntime: [{ turns: 1 }], coverage: { partial: 1 } })
    expect(reported(h.events).every((event) => event.type === "usage" && event.threadId === "thread-1")).toBe(true)
  })

  it("accepts notifications before the turn/start reply without losing or doubling receipts", async () => {
    const h = await setup()
    h.transport.beforeTurnReply = () => h.transport.receive(receipt())
    await h.start()
    h.transport.receive(receipt())
    h.transport.receive(receipt("response-2"))
    h.transport.receive(completed())
    expect(h.ledger.session("session").totalTokens).toBe(240)
  })

  it("deduplicates receipts, preserves the first conflicting value, and ignores terminal usage", async () => {
    const h = await setup()
    await h.start()
    h.transport.receive(receipt())
    h.transport.receive(receipt())
    h.transport.receive(receipt("response-1", (snapshot(9).params?.tokenUsage as { last: unknown }).last))
    const terminal = completed()
    Object.assign(terminal.params!.turn as object, { usage: (snapshot(10).params?.tokenUsage as { last: unknown }).last })
    terminal.params!.turnId = "turn-1"
    h.transport.receive(terminal)
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 120, coverage: { partial: 1 } })
  })

  it.each([null, {}, { inputTokens: 10 }, {
    totalTokens: 1000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
  }, {
    totalTokens: 10, inputTokens: 10, cachedInputTokens: 20, outputTokens: 0, reasoningOutputTokens: 0,
  }])("does not substitute a stale fallback for an invalid receipt: %j", async (usage) => {
    const h = await setup()
    await h.start()
    h.transport.receive(snapshot())
    expect(() => h.transport.receive(receipt("invalid", usage))).not.toThrow()
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 0, coverage: { unavailable: 1 } })
  })

  it("opts into receipts and discards raw response item payloads", async () => {
    const h = await setup()
    expect(h.transport.sent[0]?.params).toMatchObject({ capabilities: { experimentalApi: true, optOutNotificationMethods: ["rawResponseItem/completed"] } })
    expect(h.transport.sent.find((m) => m.method === "thread/start")?.params).toMatchObject({ experimentalRawEvents: true })
    await h.start()
    h.transport.receive({ method: "rawResponseItem/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { text: "PRIVATE_MARKER" } } })
    expect(JSON.stringify(h.events)).not.toContain("PRIVATE_MARKER")
  })

  it("retries initialization only when the opt-out field is specifically unsupported", async () => {
    const h = await setup({ rejectOptOut: true })
    expect(h.transport.sent.filter((m) => m.method === "initialize")).toHaveLength(2)
    await h.start()
    h.transport.receive(receipt())
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 120, coverage: { partial: 1 } })
  })

  it.each(["responseId", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"])("does not default missing %s to zero", async (field) => {
    const h = await setup()
    await h.start()
    const missing = receipt()
    if (field === "responseId") delete missing.params!.responseId
    else delete (missing.params!.usage as Record<string, unknown>)[field]
    h.transport.receive(snapshot())
    h.transport.receive(missing)
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 0, coverage: { unavailable: 1 } })
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100", null])("refuses invalid input counters: %j", async (inputTokens) => {
    const h = await setup()
    await h.start()
    const invalid = receipt()
    Object.assign(invalid.params!.usage as object, { inputTokens })
    h.transport.receive(invalid)
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 0, coverage: { unavailable: 1 } })
  })

  it("does not invent accounting for cache writes with unknown semantics", async () => {
    const h = await setup()
    await h.start()
    const invalid = receipt()
    Object.assign(invalid.params!.usage as object, { cacheWriteInputTokens: 20 })
    h.transport.receive(invalid)
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 0, coverage: { unavailable: 1 } })
  })

  it("counts an explicit zero receipt as reported and keeps response identity turn-scoped", async () => {
    const h = await setup()
    await h.start()
    h.transport.receive(receipt("same", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }))
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ coverage: { partial: 1, unavailable: 0 } })
    await h.start("turn-2")
    const next = receipt("same")
    next.params!.turnId = "turn-2"
    h.transport.receive(next)
    const end = completed()
    end.params!.turn = { id: "turn-2", status: "completed" }
    h.transport.receive(end)
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 120, coverage: { partial: 2 } })
  })

  it("diagnoses a late distinct receipt once, without its payload or another ledger row", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {})
    const h = await setup()
    await h.start()
    h.transport.receive(receipt())
    h.transport.receive(completed())
    h.transport.receive(receipt())
    expect(warn).not.toHaveBeenCalled()
    h.transport.receive(receipt("PRIVATE_RESPONSE"))
    h.transport.receive(receipt("ANOTHER_PRIVATE_RESPONSE"))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).toContain("CODEX_LATE_USAGE_RECEIPT")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE")
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 120, byRuntime: [{ turns: 1 }], coverage: { partial: 1 } })
  })

  it("retains expenditure while context resets and rejects unsafe sums", async () => {
    const h = await setup()
    await h.start()
    const huge = { totalTokens: Number.MAX_SAFE_INTEGER, inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
    h.transport.receive(receipt("huge", huge))
    h.transport.receive(receipt("overflow"))
    const reset = snapshot()
    reset.params!.tokenUsage = { total: { totalTokens: 1 }, last: { totalTokens: 42 }, modelContextWindow: 200 }
    expect(() => h.transport.receive(reset)).not.toThrow()
    h.transport.receive(completed())
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: Number.MAX_SAFE_INTEGER, contextTokens: 42, contextWindowTokens: 200, coverage: { partial: 1 } })
  })

  it("does not evict deduplication keys and recount receipts at the storage bound", async () => {
    const h = await setup()
    await h.start()
    for (let index = 0; index < 1100; index++) h.transport.receive(receipt(`response-${index}`))
    const before = h.ledger.session("session").totalTokens
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(1100 * 120)
    for (let index = 0; index < 1100; index++) h.transport.receive(receipt(`response-${index}`))
    h.transport.receive(completed())
    expect(h.ledger.session("session").totalTokens).toBe(before)
  })

  it.each([
    { code: -32000, message: "experimentalRawEvents unavailable after starting" },
    { code: -32602, message: "invalid model" },
  ])("does not retry an ambiguous thread creation error: %j", async (error) => {
    const h = await setup()
    h.transport.startError = error
    const before = h.transport.sent.length
    await expect(h.adapter.startThread({ cwd: "/worktree", runtime })).rejects.toThrow(error.message)
    expect(h.transport.sent.slice(before).filter((m) => m.method === "thread/start")).toHaveLength(1)
  })

  it("clears transport-local receipts and keeps persisted rows when a thread resumes", async () => {
    const h = await setup()
    await h.replay("multi")
    await h.adapter.resetConnection()
    await h.adapter.connect()
    await h.adapter.resumeThread({ threadId: "thread-1", cwd: "/worktree", runtime })
    await h.start("turn-3")
    const last = snapshot()
    last.params!.turnId = "turn-3"
    h.transport.receive(last)
    const end = completed()
    end.params!.turn = { id: "turn-3", status: "completed" }
    h.transport.receive(end)
    expect(h.ledger.session("session")).toMatchObject({ totalTokens: 840, coverage: { partial: 3 } })
  })
})
