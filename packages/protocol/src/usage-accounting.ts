import { z } from "zod"

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const counters = z.object({
  inputTokens: counter,
  cachedInputTokens: counter,
  outputTokens: counter,
  reasoningTokens: counter,
  totalTokens: counter,
  contextTokens: counter.optional(),
  contextWindowTokens: counter.positive().optional(),
})

export const accountedUsageSchema = z.discriminatedUnion("costSource", [
  counters.extend({ costSource: z.literal("unavailable") }).strict(),
  counters.extend({
    costSource: z.literal("provider-reported"), costMicros: counter,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
]).superRefine((usage, context) => {
  if (usage.cachedInputTokens > usage.inputTokens
    || usage.totalTokens < usage.inputTokens + usage.outputTokens + usage.reasoningTokens) {
    context.addIssue({ code: "custom", message: "Inconsistent usage counters" })
  }
  if ((usage.contextTokens === undefined) !== (usage.contextWindowTokens === undefined)
    || (usage.contextTokens ?? 0) > (usage.contextWindowTokens ?? 0)) {
    context.addIssue({ code: "custom", message: "Context occupancy requires a valid window" })
  }
})

export const usageObservationSchema = z.object({
  kind: z.enum(["turn", "message", "session"]),
  id: identity,
  model: identity.optional(),
  tokens: z.enum(["reported", "unavailable"]),
  final: z.boolean(),
  invalid: z.boolean(),
  usage: accountedUsageSchema,
}).strict()

export const usageAccountingSchema = z.object({
  version: z.literal(1),
  key: digest,
  threadKey: digest,
  provider: z.string().min(1).max(64),
  requestedModel: identity,
  providerTurnId: identity,
  status: z.enum(["pending", "completed", "failed", "interrupted"]),
  coverage: z.enum(["pending", "complete", "partial", "unavailable"]),
  observations: z.array(usageObservationSchema).max(10_000),
}).strict().superRefine((accounting, context) => {
  const identities = accounting.observations.map((event) => `${event.kind}\0${event.id}`)
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: "custom", path: ["observations"], message: "Duplicate usage identity" })
  }
  const reported = accounting.observations.filter((event) => event.tokens === "reported" && !event.invalid)
  const expectedCoverage = accounting.status === "pending" ? "pending"
    : reported.length === 0 ? "unavailable"
      : reported.length === accounting.observations.length && reported.every((event) => event.final)
        ? "complete" : "partial"
  if (accounting.coverage !== expectedCoverage) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Coverage must match the reported evidence" })
  }
})

export const usageCoverageSchema = z.object({
  pending: counter, complete: counter, partial: counter, unavailable: counter, legacy: counter,
}).strict()

// A cumulative provider-session cost has no per-turn or time-window attribution.
export const providerSessionCostSchema = z.object({
  provider: z.string().min(1).max(64), threadKey: digest,
  costMicros: counter, currency: z.string().regex(/^[A-Z]{3}$/),
}).strict()

export type UsageAccounting = z.infer<typeof usageAccountingSchema>
export type UsageObservation = z.infer<typeof usageObservationSchema>
export type UsageCoverage = z.infer<typeof usageCoverageSchema>
