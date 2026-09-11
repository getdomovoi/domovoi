import { createHash } from "node:crypto"
import { usageAccountingSchema, usageObservationSchema, type UsageAccounting, type UsageCoverage } from "@getdomovoi/protocol"
import type { NormalizedUsage, UsageSource } from "./usage.js"

export type UsageDispatch = {
  sessionId: string; provider: string; threadId: string; turnId: string; model: string
  startedAt?: string
}
export type UsageIdentity = Pick<UsageDispatch, "provider" | "threadId" | "turnId">
export type UsageReport = { usage: NormalizedUsage; source?: UsageSource }

export function usageIdentity(input: UsageIdentity): string {
  return digest([input.provider, input.threadId, input.turnId])
}

function digest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

export function beginUsageAccounting(input: UsageDispatch): UsageAccounting {
  return usageAccountingSchema.parse({
    version: 1, key: usageIdentity(input), threadKey: digest([input.provider, input.threadId]),
    provider: input.provider, requestedModel: input.model, providerTurnId: input.turnId,
    status: "pending", coverage: "pending", observations: [],
  })
}

export function observeUsage(accounting: UsageAccounting, report: UsageReport): UsageAccounting {
  const source = report.source ?? { kind: "turn", tokens: "reported" }
  const observation = usageObservationSchema.parse({
    ...source, id: source.id ?? source.kind, final: source.final ?? true,
    invalid: source.invalid ?? false, usage: report.usage,
  })
  const next = structuredClone(accounting)
  const index = next.observations.findIndex((event) => event.kind === observation.kind && event.id === observation.id)
  const previous = next.observations[index]
  // Replayed provisional snapshots cannot erase a final observation or larger counters.
  if (previous && !previous.invalid && (observation.invalid
    || (previous.final && !observation.final)
    || observation.usage.totalTokens < previous.usage.totalTokens
    || (source.kind === "session" && (observation.usage.costSource === "provider-reported")
      && previous.usage.costSource === "provider-reported"
      && observation.usage.costMicros < previous.usage.costMicros))) return accounting
  if (index === -1) next.observations.push(observation)
  else next.observations[index] = observation
  return updateUsageCoverage(next)
}

export function updateUsageCoverage(accounting: UsageAccounting): UsageAccounting {
  const reported = accounting.observations.filter((event) => event.tokens === "reported" && !event.invalid)
  const coverage = accounting.status === "pending" ? "pending"
    : reported.length === 0 ? "unavailable"
      : reported.length === accounting.observations.length && reported.every((event) => event.final)
        ? "complete" : "partial"
  return usageAccountingSchema.parse({ ...accounting, coverage })
}

export function accountedUsage(accounting: UsageAccounting): NormalizedUsage {
  const result: NormalizedUsage = {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    totalTokens: 0, costSource: "unavailable",
  }
  for (const event of accounting.observations) {
    if (event.invalid) continue
    const usage = event.usage
    if (event.tokens === "reported") {
      for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const) {
        result[key] += usage[key]
        if (!Number.isSafeInteger(result[key])) throw new Error("Usage exceeds safe integer range")
      }
    }
    if (usage.contextTokens !== undefined && usage.contextWindowTokens !== undefined) {
      result.contextTokens = usage.contextTokens
      result.contextWindowTokens = usage.contextWindowTokens
    }
    if (event.kind !== "session" && usage.costSource === "provider-reported") {
      if (result.currency && result.currency !== usage.currency) throw new Error("Cannot aggregate mixed currencies")
      result.costSource = "provider-reported"
      result.currency = usage.currency
      result.costMicros = (result.costMicros ?? 0) + usage.costMicros
      if (!Number.isSafeInteger(result.costMicros)) throw new Error("Usage cost exceeds safe integer range")
    }
  }
  return result
}

export function usageCoverage(accountings: Array<UsageAccounting | undefined>): { coverage?: UsageCoverage } {
  if (!accountings.some(Boolean)) return {}
  const coverage: UsageCoverage = { pending: 0, complete: 0, partial: 0, unavailable: 0, legacy: 0 }
  for (const accounting of accountings) coverage[accounting?.coverage ?? "legacy"]++
  return { coverage }
}
