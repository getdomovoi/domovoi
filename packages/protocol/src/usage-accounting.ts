import { z } from "zod"
import { offsetDateTimeSchema } from "./validation.js"

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const sessionTurnIdSchema = digest
export const sessionTurnStatusSchema = z.enum(["pending", "completed", "failed", "interrupted"])
export const sessionTurnCoverageSchema = z.enum(["pending", "complete", "partial", "unavailable"])
export const sessionTurnMetadataSchema = z.object({
  ordinal: counter.positive(),
  startedAt: offsetDateTimeSchema,
  completedAt: offsetDateTimeSchema.optional(),
  // "daemon-restart": the turn was still running when the daemon stopped, and
  // completedAt is when the restarted daemon recorded it as interrupted, not
  // when the turn ended (ruling Q401). Absent: completedAt is when the daemon
  // saw the turn end, or a record written before this field existed.
  completedAtSource: z.literal("daemon-restart").optional(),
}).strict()

function restartSourceAgrees(
  turn: { completedAt?: string | undefined, completedAtSource?: "daemon-restart" | undefined },
  status: z.infer<typeof sessionTurnStatusSchema>,
): boolean {
  return turn.completedAtSource === undefined || (status === "interrupted" && turn.completedAt !== undefined)
}
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
  status: sessionTurnStatusSchema,
  coverage: sessionTurnCoverageSchema,
  // Absent on records created before durable turn ordinals existed.
  turn: sessionTurnMetadataSchema.optional(),
  observations: z.array(usageObservationSchema).max(10_000),
}).strict().superRefine((accounting, context) => {
  if (accounting.turn && (accounting.status === "pending") !== (accounting.turn.completedAt === undefined)) {
    context.addIssue({ code: "custom", path: ["turn", "completedAt"], message: "Only terminal turns have a completion time" })
  }
  if (accounting.turn && !restartSourceAgrees(accounting.turn, accounting.status)) {
    context.addIssue({ code: "custom", path: ["turn", "completedAtSource"], message: "Only an interrupted turn is recorded at a restart" })
  }
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

// History includes the exact linked dispatch, even when its messages span pages.
// recordedToolCount counts stored tool rows, not all provider-internal tool calls.
export const sessionTurnSchema = z.object({
  id: sessionTurnIdSchema,
  sessionId: identity,
  ...sessionTurnMetadataSchema.shape,
  provider: z.string().min(1).max(64),
  requestedModel: identity,
  reportedModels: z.array(identity).max(10_000).refine((models) => new Set(models).size === models.length),
  status: sessionTurnStatusSchema,
  coverage: sessionTurnCoverageSchema,
  usage: accountedUsageSchema,
  recordedToolCount: counter,
}).strict().superRefine((turn, context) => {
  if ((turn.status === "pending") !== (turn.completedAt === undefined)
    || (turn.status === "pending") !== (turn.coverage === "pending")
    || !restartSourceAgrees(turn, turn.status)) {
    context.addIssue({ code: "custom", message: "Turn status, completion time and coverage must agree" })
  }
})

// A turn as the snapshot carries it (ruling Q401): when it started and ended,
// for desktop's and tablet's "Worked for N" and header clock. Derived from the
// usage ledger for the turns the snapshot's thread links, never stored in the
// snapshot. A pending turn is running. completed and failed turns ended when
// the daemon saw them end. An interrupted turn has completedAt only when the
// daemon saw it stop; one that was running when the daemon itself stopped has
// none, because nobody knows when it ended.
export const snapshotTurnSchema = z.object({
  id: sessionTurnIdSchema,
  sessionId: identity,
  ordinal: counter.positive(),
  startedAt: offsetDateTimeSchema,
  completedAt: offsetDateTimeSchema.optional(),
  status: sessionTurnStatusSchema,
}).strict().superRefine((turn, context) => {
  const ended = turn.completedAt !== undefined
  if (turn.status === "pending" ? ended : turn.status !== "interrupted" && !ended) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "A turn's end must agree with its status" })
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
export type SessionTurn = z.infer<typeof sessionTurnSchema>
export type SnapshotTurn = z.infer<typeof snapshotTurnSchema>
