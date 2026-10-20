import type { AgentEvent } from "./agents.js"
import type { NormalizedUsage } from "./usage.js"

const counters = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const
const empty = (): NormalizedUsage => ({
  inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  totalTokens: 0, costSource: "unavailable",
})
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
const key = (threadId: string, turnId: string): string => JSON.stringify([threadId, turnId])

// Codex includes cached input in input and reasoning in output. Unlike the
// general provider parser, require every bucket and exact equality: overflow
// and compaction can put context estimates in last.totalTokens with zero buckets.
function expenditure(value: unknown): NormalizedUsage | undefined {
  const raw = record(value)
  if (!raw) return
  const { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens } = raw
  if (!count(inputTokens) || !count(cachedInputTokens) || !count(outputTokens)
    || !count(reasoningOutputTokens) || !count(totalTokens)
    || cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens
    || inputTokens + outputTokens !== totalTokens
    // No established accounting semantics for nonzero cache writes.
    || (raw.cacheWriteInputTokens !== undefined && raw.cacheWriteInputTokens !== 0)) return
  return { inputTokens, cachedInputTokens, outputTokens: outputTokens - reasoningOutputTokens,
    reasoningTokens: reasoningOutputTokens, totalTokens, costSource: "unavailable" }
}

type Turn = {
  threadId: string
  turnId: string
  rawEligible: boolean
  rawSeen: boolean
  receipts: Set<string>
  sum: NormalizedUsage | undefined
  fallback: NormalizedUsage | undefined
  context: Pick<NormalizedUsage, "contextTokens" | "contextWindowTokens">
  warned: boolean
}

// Transport-local evidence only. Persist one cumulative turn observation in
// the ledger; never subtract thread totals or mix a last snapshot into a sum.
export class CodexUsage {
  #rawThreads = new Set<string>()
  #expected = new Set<string>()
  #active = new Map<string, Turn>()
  #sealed = new Map<string, Turn>()
  constructor(private readonly emit: (event: AgentEvent) => void) {}

  opened(threadId: string, rawEligible: boolean): void {
    if (rawEligible && this.#rawThreads.size < 4096) this.#rawThreads.add(threadId)
    else this.#rawThreads.delete(threadId)
  }

  archived(threadId: string): void {
    this.#rawThreads.delete(threadId)
    this.#expected.delete(threadId)
    for (const turn of this.#active.values()) if (turn.threadId === threadId) this.complete(threadId, turn.turnId)
  }

  expect(threadId: string): void { this.#expected.add(threadId) }
  cancel(threadId: string): void { this.#expected.delete(threadId) }

  started(threadId: unknown, turnId: unknown): void {
    if (!id(threadId) || !id(turnId) || !this.#expected.delete(threadId)) return
    const identity = key(threadId, turnId)
    if (this.#active.has(identity) || this.#sealed.has(identity) || this.#active.size >= 256) return
    this.#active.set(identity, { threadId, turnId, rawEligible: this.#rawThreads.has(threadId),
      rawSeen: false, receipts: new Set(), sum: undefined, fallback: undefined, context: {}, warned: false })
  }

  receipt(params: Record<string, unknown>): void {
    const { threadId, turnId, responseId } = params
    if (!id(threadId) || !id(turnId)) return
    const identity = key(threadId, turnId)
    const turn = this.#active.get(identity)
    if (!turn) {
      const sealed = this.#sealed.get(identity)
      if (sealed && id(responseId) && !sealed.receipts.has(responseId) && !sealed.warned) {
        sealed.warned = true
        process.emitWarning("Codex reported new usage after turn completion; the count remains partial.", { code: "CODEX_LATE_USAGE_RECEIPT" })
      }
      return
    }
    // A resumed thread may still be resident in Codex with raw events enabled.
    // Its live fallback is already published: do not mix accounting modes.
    if (!turn.rawEligible) return
    turn.rawSeen = true
    if (!id(responseId) || turn.receipts.has(responseId) || turn.receipts.size >= 1024) return
    // Retain invalid IDs too: a conflicting replay cannot change prior evidence.
    turn.receipts.add(responseId)
    const usage = expenditure(params.usage)
    if (!usage) return
    const sum = { ...(turn.sum ?? empty()) }
    for (const counter of counters) {
      sum[counter] += usage[counter]
      if (!Number.isSafeInteger(sum[counter])) return
    }
    turn.sum = sum
    this.#publish(turn)
  }

  snapshot(params: Record<string, unknown>): void {
    const { threadId, turnId } = params
    if (!id(threadId) || !id(turnId)) return
    const turn = this.#active.get(key(threadId, turnId))
    if (!turn) return
    const tokenUsage = record(params.tokenUsage)
    const last = record(tokenUsage?.last)
    const contextTokens = last?.totalTokens
    const contextWindowTokens = tokenUsage?.modelContextWindow
    if (count(contextTokens) && count(contextWindowTokens)
      && contextWindowTokens > 0 && contextTokens <= contextWindowTokens) {
      turn.context = { contextTokens, contextWindowTokens }
    }
    const fallback = expenditure(last)
    if (fallback && (!turn.fallback || fallback.totalTokens > turn.fallback.totalTokens)) turn.fallback = fallback
    this.#publish(turn)
  }

  complete(threadId: unknown, turnId: unknown): void {
    if (!id(threadId) || !id(turnId)) return
    const identity = key(threadId, turnId)
    const turn = this.#active.get(identity)
    if (!turn) return
    this.#publish(turn, true)
    this.#active.delete(identity)
    // Evict entire sealed identities, never active receipt IDs. An evicted
    // identity cannot be recreated by unsolicited usage or lifecycle messages.
    if (this.#sealed.size >= 128) this.#sealed.delete(this.#sealed.keys().next().value!)
    this.#sealed.set(identity, turn)
  }

  clear(): void {
    for (const turn of this.#active.values()) this.#publish(turn, true)
    this.#active.clear()
    this.#sealed.clear()
    this.#expected.clear()
    this.#rawThreads.clear()
  }

  #publish(turn: Turn, terminal = false): void {
    const usage = turn.sum ?? (!turn.rawSeen && (!turn.rawEligible || terminal) ? turn.fallback : undefined)
    if (!usage && turn.context.contextTokens === undefined) return
    this.emit({ type: "usage", threadId: turn.threadId, turnId: turn.turnId,
      usage: { ...(usage ?? empty()), ...turn.context },
      // 0.162.1 can silently retry billed HTTP/WebSocket attempts. Success,
      // compaction, child activity or absence of errors never proves completeness.
      source: { kind: "turn", tokens: usage ? "reported" : "unavailable", final: false } })
  }
}
