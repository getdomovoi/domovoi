export type ProviderCost = { amount: number; currency: string }

export type NormalizedUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  costSource: "provider-reported" | "unavailable"
  costMicros?: number
  currency?: string
}

export type TurnUsage = {
  sessionId: string
  turnId: string
  provider: string
  model: string
  usage: NormalizedUsage
}

export function normalizeUsage(input: {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
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
  const base = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
  }
  if (!input.cost) return { ...base, costSource: "unavailable" }
  if (!Number.isFinite(input.cost.amount) || input.cost.amount < 0) {
    throw new Error("Provider cost must be a non-negative number")
  }
  const currency = input.cost.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Provider cost currency must be ISO 4217")
  return {
    ...base,
    costMicros: Math.round(input.cost.amount * 1_000_000),
    currency,
    costSource: "provider-reported",
  }
}

export class UsageLedger {
  readonly #turns = new Map<string, TurnUsage>()

  record(record: TurnUsage): void {
    const currency = record.usage.currency
    if (currency) {
      const existing = [...this.#turns.values()].find((candidate) => (
        candidate.sessionId === record.sessionId
        && candidate.turnId !== record.turnId
        && candidate.usage.currency
        && candidate.usage.currency !== currency
      ))
      if (existing) throw new Error("Cannot aggregate provider costs with mixed currencies")
    }
    this.#turns.set(turnKey(record.sessionId, record.turnId), structuredClone(record))
  }

  session(sessionId: string) {
    const turns = [...this.#turns.values()].filter((turn) => turn.sessionId === sessionId)
    const totals = sumUsage(turns.map((turn) => turn.usage))
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
    return { sessionId, ...totals, byRuntime }
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

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`
}
