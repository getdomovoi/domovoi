import { chmodSync, existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import {
  sessionTransferUsageRecordSchema,
  type SessionTransferUsageRecord,
} from "@getdomovoi/protocol"

export type ProviderCost = { amount: number; currency: string }

type ActiveUsageContext = {
  provider: string
  model: string
  threadId?: string
}

export type NormalizedUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  costSource: "provider-reported" | "unavailable"
  contextTokens?: number
  contextWindowTokens?: number
  costMicros?: number
  currency?: string
}

export type TurnUsage = {
  sessionId: string
  turnId: string
  threadId?: string
  provider: string
  model: string
  usage: NormalizedUsage
}

export function normalizeUsage(input: {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  contextTokens?: number
  contextWindowTokens?: number
  cost?: ProviderCost
}): NormalizedUsage {
  const inputTokens = input.inputTokens ?? 0
  const cachedInputTokens = input.cachedInputTokens ?? 0
  const outputTokens = input.outputTokens ?? 0
  const reasoningTokens = input.reasoningTokens ?? 0
  if (![inputTokens, cachedInputTokens, outputTokens, reasoningTokens].every(isTokenCount)) {
    throw new Error("Token counters must be non-negative integers")
  }
  if (cachedInputTokens > inputTokens) {
    throw new Error("Cached input tokens cannot exceed input tokens")
  }
  const knownTotal = inputTokens + outputTokens + reasoningTokens
  const totalTokens = input.totalTokens ?? knownTotal
  if (!isTokenCount(totalTokens) || totalTokens < knownTotal) {
    throw new Error("Total tokens must be a non-negative integer at least as large as known tokens")
  }
  const base = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    ...reportedContextOccupancy(input.contextTokens, input.contextWindowTokens),
  }
  if (!input.cost) return { ...base, costSource: "unavailable" }
  if (!Number.isFinite(input.cost.amount) || input.cost.amount < 0) {
    throw new Error("Provider cost must be a non-negative number")
  }
  const currency = input.cost.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Provider cost currency must be ISO 4217")
  return {
    ...base,
    costMicros: safeCostMicros(input.cost.amount),
    currency,
    costSource: "provider-reported",
  }
}

export function normalizeProviderUsage(payload: unknown): NormalizedUsage | undefined {
  const root = record(payload)
  const usage = record(root?.usage) ?? record(root?.tokens)
  if (!root || !usage) return undefined
  const cache = record(usage.cache)
  const inputTokens = counter(usage.input_tokens ?? usage.inputTokens ?? usage.input)
  const cachedInputTokens = counter(
    usage.cache_read_input_tokens ?? usage.cachedInputTokens ?? cache?.read,
  )
  const reportedOutputTokens = counter(
    usage.output_tokens ?? usage.outputTokens ?? usage.output,
  )
  const embeddedReasoningTokens = counter(
    usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
  )
  const reasoningTokens = counter(
    usage.reasoning_tokens
      ?? usage.reasoningTokens
      ?? embeddedReasoningTokens
      ?? usage.reasoning,
  )
  // Codex reports reasoningOutputTokens as a subset of outputTokens. The
  // normalized counters are disjoint, so split that subset without changing
  // the provider's total.
  const outputTokens = reportedOutputTokens !== undefined
    && embeddedReasoningTokens !== undefined
    ? reportedOutputTokens - embeddedReasoningTokens
    : reportedOutputTokens
  const totalTokens = counter(usage.total_tokens ?? usage.totalTokens ?? usage.total)
  const context = reportedContextOccupancy(
    root.context_tokens ?? root.contextTokens,
    root.context_window_tokens ?? root.contextWindowTokens,
  )
  const rawCost = root.total_cost_usd ?? root.cost_usd ?? root.cost
  const cost = typeof rawCost === "number" ? { amount: rawCost, currency: "USD" } : undefined
  if (
    [inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens]
      .every((value) => value === undefined)
    && !cost
    && context.contextTokens === undefined
  ) {
    return undefined
  }
  return normalizeUsage({
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...context,
    ...(cost ? { cost } : {}),
  })
}

export class UsageLedger {
  readonly #database: DatabaseSync
  readonly #path: string

  constructor(path = ":memory:") {
    this.#path = path
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS provider_usage (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        provider_thread_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        context_tokens INTEGER,
        context_window_tokens INTEGER,
        cost_source TEXT NOT NULL CHECK (cost_source IN ('provider-reported', 'unavailable')),
        cost_micros INTEGER,
        currency TEXT,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS provider_usage_session ON provider_usage(session_id);
    `)
    this.#addColumnIfMissing("provider_thread_id", "TEXT")
    this.#addColumnIfMissing("context_tokens", "INTEGER")
    this.#addColumnIfMissing("context_window_tokens", "INTEGER")
    this.#restrictFilePermissions()
  }

  record(record: TurnUsage): void {
    const currency = record.usage.currency
    const context = reportedContextOccupancy(
      record.usage.contextTokens,
      record.usage.contextWindowTokens,
    )
    if (currency) {
      const existing = this.#database.prepare(`
        SELECT currency FROM provider_usage
        WHERE session_id = ? AND turn_id <> ? AND currency IS NOT NULL AND currency <> ?
        LIMIT 1
      `).get(record.sessionId, record.turnId, currency)
      if (existing) throw new Error("Cannot aggregate provider costs with mixed currencies")
    }
    this.#database.prepare(`
      INSERT INTO provider_usage (
        session_id, turn_id, provider_thread_id, provider, model,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
        context_tokens, context_window_tokens,
        cost_source, cost_micros, currency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn_id) DO UPDATE SET
        provider_thread_id = excluded.provider_thread_id,
        provider = excluded.provider,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_tokens = excluded.total_tokens,
        context_tokens = COALESCE(excluded.context_tokens, provider_usage.context_tokens),
        context_window_tokens = COALESCE(
          excluded.context_window_tokens,
          provider_usage.context_window_tokens
        ),
        cost_source = excluded.cost_source,
        cost_micros = excluded.cost_micros,
        currency = excluded.currency
    `).run(
      record.sessionId,
      record.turnId,
      record.threadId ?? null,
      record.provider,
      record.model,
      record.usage.inputTokens,
      record.usage.cachedInputTokens,
      record.usage.outputTokens,
      record.usage.reasoningTokens,
      record.usage.totalTokens,
      context.contextTokens ?? null,
      context.contextWindowTokens ?? null,
      record.usage.costSource,
      record.usage.costMicros ?? null,
      record.usage.currency ?? null,
    )
    this.#restrictFilePermissions()
  }

  session(sessionId: string, active?: ActiveUsageContext) {
    const rows = this.#sessionRows(sessionId)
    const turns = rows.map(turnUsageFromRow)
    const totals = sumUsage(turns.map((turn) => turn.usage))
    const context = currentContextOccupancy(rows.at(-1), active)
    const groups = new Map<string, TurnUsage[]>()
    for (const turn of turns) {
      const key = `${turn.provider}\0${turn.model}`
      const group = groups.get(key) ?? []
      group.push(turn)
      groups.set(key, group)
    }
    const byRuntime = [...groups.values()].map((group) => {
      const first = group[0]!
      return {
        provider: first.provider,
        model: first.model,
        ...sumUsage(group.map((turn) => turn.usage), false),
        turns: group.length,
      }
    }).sort((left, right) => (
      `${left.provider}\0${left.model}`.localeCompare(`${right.provider}\0${right.model}`)
    ))
    return { sessionId, ...totals, ...context, byRuntime }
  }

  transferSession(sessionId: string): SessionTransferUsageRecord[] {
    return this.#sessionRows(sessionId).map((row) => {
      const turn = turnUsageFromRow(row)
      return sessionTransferUsageRecordSchema.parse({
        turnId: turn.turnId,
        provider: turn.provider,
        model: turn.model,
        ...turn.usage,
      })
    })
  }

  replaceTransferredSession(
    sessionId: string,
    records: readonly SessionTransferUsageRecord[],
  ): void {
    const parsed = sessionTransferUsageRecordSchema.array().parse(records)
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      this.#database.prepare("DELETE FROM provider_usage WHERE session_id = ?").run(sessionId)
      for (const record of parsed) {
        const usage: NormalizedUsage = {
          inputTokens: record.inputTokens,
          cachedInputTokens: record.cachedInputTokens,
          outputTokens: record.outputTokens,
          reasoningTokens: record.reasoningTokens,
          totalTokens: record.totalTokens,
          costSource: record.costSource,
          ...(record.contextTokens === undefined ? {} : {
            contextTokens: record.contextTokens,
            contextWindowTokens: record.contextWindowTokens!,
          }),
          ...(record.costSource === "provider-reported" ? {
            costMicros: record.costMicros,
            currency: record.currency,
          } : {}),
        }
        const { turnId, provider, model } = record
        this.record({ sessionId, turnId, provider, model, usage })
      }
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
    this.#restrictFilePermissions()
  }

  close(): void {
    this.#database.close()
  }

  #restrictFilePermissions(): void {
    if (this.#path === ":memory:" || process.platform === "win32") return
    for (const path of [this.#path, `${this.#path}-wal`, `${this.#path}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  }

  #addColumnIfMissing(name: string, type: "TEXT" | "INTEGER"): void {
    const columns = this.#database.prepare("PRAGMA table_info(provider_usage)").all()
      .map((column) => String((column as Record<string, unknown>).name))
    if (!columns.includes(name)) this.#database.exec(`ALTER TABLE provider_usage ADD COLUMN ${name} ${type}`)
  }

  #sessionRows(sessionId: string): unknown[] {
    return this.#database.prepare(`
      SELECT
        session_id, turn_id, provider_thread_id, provider, model,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
        context_tokens, context_window_tokens,
        cost_source, cost_micros, currency
      FROM provider_usage WHERE session_id = ? ORDER BY rowid
    `).all(sessionId)
  }
}

function sumUsage(usages: NormalizedUsage[], includeAvailability = true) {
  const currency = usages.find((usage) => usage.currency)?.currency
  const base = {
    inputTokens: sum(usages, "inputTokens"),
    cachedInputTokens: sum(usages, "cachedInputTokens"),
    outputTokens: sum(usages, "outputTokens"),
    reasoningTokens: sum(usages, "reasoningTokens"),
    totalTokens: sum(usages, "totalTokens"),
    costMicros: usages.reduce((total, usage) => total + (usage.costMicros ?? 0), 0),
    ...(currency ? { currency } : {}),
  }
  if (!includeAvailability) return base
  return {
    ...base,
    reportedCostTurns: usages.filter((usage) => usage.costSource === "provider-reported").length,
    unavailableCostTurns: usages.filter((usage) => usage.costSource === "unavailable").length,
  }
}

function sum(usages: NormalizedUsage[], key: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens"): number {
  return usages.reduce((total, usage) => total + usage[key], 0)
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function safeCostMicros(amount: number): number {
  const micros = Math.round(amount * 1_000_000)
  if (!Number.isSafeInteger(micros)) throw new Error("Provider cost exceeds safe integer range")
  return micros
}

function turnUsageFromRow(value: unknown): TurnUsage {
  const row = value as Record<string, unknown>
  const usage: NormalizedUsage = {
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens),
    costSource: row.cost_source as NormalizedUsage["costSource"],
    ...reportedContextOccupancy(row.context_tokens, row.context_window_tokens),
    ...(row.cost_source === "provider-reported" && typeof row.cost_micros === "number"
      ? { costMicros: row.cost_micros }
      : {}),
    ...(row.cost_source === "provider-reported" && typeof row.currency === "string"
      ? { currency: row.currency }
      : {}),
  }
  return {
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    ...(typeof row.provider_thread_id === "string" ? { threadId: row.provider_thread_id } : {}),
    provider: String(row.provider),
    model: String(row.model),
    usage,
  }
}

function currentContextOccupancy(
  value: unknown,
  active?: ActiveUsageContext,
): { contextTokens?: number; contextWindowTokens?: number } {
  const row = record(value)
  if (!row) return {}
  if (active && (
    row.provider !== active.provider
    || row.model !== active.model
    || active.threadId === undefined
    || row.provider_thread_id !== active.threadId
  )) return {}
  return reportedContextOccupancy(row.context_tokens, row.context_window_tokens)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function reportedContextOccupancy(
  rawContextTokens: unknown,
  rawContextWindowTokens: unknown,
): { contextTokens?: number; contextWindowTokens?: number } {
  const contextTokens = counter(rawContextTokens)
  const contextWindowTokens = counter(rawContextWindowTokens)
  if (
    contextTokens === undefined
    || contextWindowTokens === undefined
    || contextWindowTokens === 0
    || contextTokens > contextWindowTokens
  ) return {}
  return { contextTokens, contextWindowTokens }
}
