import { z } from "zod"

import { offsetDateTimeSchema, utf16MaxLength } from "./validation.js"

import {
  annotationSchema,
  artifactSchema,
  permissionModeSchema,
  reasoningEffortSchema,
  sessionForkOriginSchema,
  sessionTransferOriginSchema,
  threadItemSchema,
  workingPlanSchema,
} from "./schema.js"
import { commitShaSchema, machineIdSchema, sha256DigestSchema } from "./identifiers.js"
import { sourceRefusalSchema } from "./transfer.js"
import { transferRefusalSchema } from "./transfer-preflight.js"
import { sessionTransferContractRefusalSchema } from "./transfer-contract-refusals.js"
import { usageAccountingSchema } from "./usage-accounting.js"
import {
  sessionTransferCoverageSchema,
  sessionTransferIncludedKindSchema,
  sessionTransferExcludedKindSchema,
  sessionTransferWarningKindSchema,
} from "./transfer-coverage.js"

export {
  sessionTransferCoverageSchema,
  sessionTransferIncludedKindSchema,
  sessionTransferExcludedKindSchema,
  sessionTransferWarningKindSchema,
} from "./transfer-coverage.js"

export {
  sessionTransferContractRefusalMessage,
  sessionTransferContractRefusalSchema,
  type SessionTransferContractRefusal,
} from "./transfer-contract-refusals.js"

// Version 2 carries portable usage accounting that strict version-1 readers cannot parse.
export const sessionTransferContractVersion = 2 as const
export const sessionTransferContractVersionSchema = z.literal(sessionTransferContractVersion)
export const sessionTransferIntentDigestSchema = sha256DigestSchema

export const maximumSessionTransferThreadItems = 100_000
export const maximumSessionTransferArtifacts = 10_000
export const maximumSessionTransferAnnotations = 10_000
export const maximumSessionTransferUsageRecords = 100_000

const safeCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const sessionTransferRuntimeSchema = z.object({
  provider: z.string().min(1).check(utf16MaxLength(64)),
  model: z.string().min(1).check(utf16MaxLength(256)),
  reasoning: reasoningEffortSchema,
  permissionMode: permissionModeSchema,
}).strict()

export const sessionTransferForkOriginSchema = sessionForkOriginSchema.extend({
  sourceMachineId: machineIdSchema,
}).strict()

export const sessionTransferSessionSchema = z.object({
  id: z.string().trim().min(1).check(utf16MaxLength(128)),
  title: z.string().min(1),
  runtime: sessionTransferRuntimeSchema,
  changedFiles: safeCounterSchema,
  testsPassed: safeCounterSchema,
  testsFailed: safeCounterSchema,
  updatedAt: offsetDateTimeSchema,
  baseCommit: commitShaSchema,
  ownershipGeneration: safeCounterSchema,
  forkedFrom: sessionTransferForkOriginSchema.optional(),
  transferredFrom: sessionTransferOriginSchema.optional(),
}).strict()

const transferUsageBase = z.object({
  turnId: z.string().trim().min(1).check(utf16MaxLength(256)),
  provider: z.string().trim().min(1).check(utf16MaxLength(64)),
  model: z.string().trim().min(1).check(utf16MaxLength(256)),
  accounting: usageAccountingSchema.optional(),
  inputTokens: safeCounterSchema,
  cachedInputTokens: safeCounterSchema,
  outputTokens: safeCounterSchema,
  reasoningTokens: safeCounterSchema,
  totalTokens: safeCounterSchema,
  contextTokens: safeCounterSchema.optional(),
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
})

export const sessionTransferUsageRecordSchema = z.discriminatedUnion("costSource", [
  transferUsageBase.extend({
    costSource: z.literal("provider-reported"),
    costMicros: safeCounterSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
  transferUsageBase.extend({
    costSource: z.literal("unavailable"),
    costMicros: z.never().optional(),
    currency: z.never().optional(),
  }).strict(),
]).superRefine((usage, context) => {
  if (usage.accounting) {
    const accounting = usage.accounting
    const valid = accounting.observations.filter((event) => !event.invalid)
    const tokenReports = valid.filter((event) => event.tokens === "reported")
    const costReports = valid.flatMap((event) => event.kind !== "session" && event.usage.costSource === "provider-reported"
      ? [event.usage] : [])
    const countersMatch = (["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const)
      .every((key) => usage[key] === tokenReports.reduce((sum, event) => sum + event.usage[key], 0))
    const costMatches = costReports.length === 0 ? usage.costSource === "unavailable"
      : usage.costSource === "provider-reported"
        && costReports.every((report) => report.currency === usage.currency)
        && usage.costMicros === costReports.reduce((sum, report) => sum + report.costMicros, 0)
    if (usage.turnId !== accounting.key || usage.provider !== accounting.provider
      || usage.model !== accounting.requestedModel || !countersMatch || !costMatches) {
      context.addIssue({ code: "custom", path: ["accounting"], message: "Usage must match its accounting evidence" })
    }
  }
  if (usage.cachedInputTokens > usage.inputTokens) {
    context.addIssue({
      code: "custom",
      path: ["cachedInputTokens"],
      message: "Cached input tokens cannot exceed input tokens",
    })
  }
  if (usage.totalTokens < usage.inputTokens + usage.outputTokens + usage.reasoningTokens) {
    context.addIssue({
      code: "custom",
      path: ["totalTokens"],
      message: "Total tokens cannot be smaller than the known token counters",
    })
  }
  const hasContext = usage.contextTokens !== undefined
  const hasWindow = usage.contextWindowTokens !== undefined
  if (hasContext !== hasWindow) {
    context.addIssue({
      code: "custom",
      path: hasContext ? ["contextWindowTokens"] : ["contextTokens"],
      message: "Transferred context occupancy requires both counters",
    })
  } else if (
    usage.contextTokens !== undefined
    && usage.contextWindowTokens !== undefined
    && usage.contextTokens > usage.contextWindowTokens
  ) {
    context.addIssue({
      code: "custom",
      path: ["contextTokens"],
      message: "Context occupancy cannot exceed its window",
    })
  }
})

export const sessionTransferStateSchema = z.object({
  version: sessionTransferContractVersionSchema,
  session: sessionTransferSessionSchema,
  thread: z.array(threadItemSchema).max(maximumSessionTransferThreadItems),
  artifacts: z.array(artifactSchema).max(maximumSessionTransferArtifacts),
  workingPlan: workingPlanSchema.optional(),
  annotations: z.array(annotationSchema).max(maximumSessionTransferAnnotations),
  usage: z.array(sessionTransferUsageRecordSchema).max(maximumSessionTransferUsageRecords),
}).strict().superRefine((state, context) => {
  const sessionId = state.session.id
  const checkSession = (
    records: ReadonlyArray<{ sessionId: string }>,
    path: "thread" | "artifacts" | "annotations",
  ) => {
    records.forEach((record, index) => {
      if (record.sessionId !== sessionId) {
        context.addIssue({
          code: "custom",
          path: [path, index, "sessionId"],
          message: "Transferred records must belong to the transferred session",
        })
      }
    })
  }
  checkSession(state.thread, "thread")
  checkSession(state.artifacts, "artifacts")
  checkSession(state.annotations, "annotations")

  const threadIds = new Set<string>()
  const providerMessageKeys = new Set<string>()
  state.thread.forEach((item, index) => {
    if (item.kind === "user" && item.providerMessageKey) {
      if (providerMessageKeys.has(item.providerMessageKey)) {
        context.addIssue({ code: "custom", path: ["thread", index, "providerMessageKey"], message: "Transferred provider message identities must be unique" })
      }
      providerMessageKeys.add(item.providerMessageKey)
    }
    if (threadIds.has(item.id)) {
      context.addIssue({ code: "custom", path: ["thread", index, "id"], message: "Transferred thread IDs must be unique" })
    }
    threadIds.add(item.id)
  })
  const artifactIds = new Set<string>()
  state.artifacts.forEach((artifact, index) => {
    if (artifactIds.has(artifact.id)) {
      context.addIssue({ code: "custom", path: ["artifacts", index, "id"], message: "Transferred artifact IDs must be unique" })
    }
    artifactIds.add(artifact.id)
  })
  const annotationIds = new Set<string>()
  state.annotations.forEach((annotation, index) => {
    if (annotationIds.has(annotation.id)) {
      context.addIssue({ code: "custom", path: ["annotations", index, "id"], message: "Transferred annotation IDs must be unique" })
    }
    annotationIds.add(annotation.id)
    if (!artifactIds.has(annotation.artifactId)) {
      context.addIssue({
        code: "custom",
        path: ["annotations", index, "artifactId"],
        message: "Transferred annotations must reference a transferred artifact",
      })
    }
  })

  if (state.workingPlan) {
    if (state.workingPlan.sessionId !== sessionId) {
      context.addIssue({
        code: "custom",
        path: ["workingPlan", "sessionId"],
        message: "The transferred working plan must belong to the transferred session",
      })
    }
    if (state.workingPlan.providerSync !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["workingPlan", "providerSync"],
        message: "Provider sync is native provider state and cannot transfer between machines",
      })
    }
    state.workingPlan.steps.forEach((step, index) => {
      if (step.blocker !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["workingPlan", "steps", index, "blocker"],
          message: "A session with an open approval blocker cannot transfer",
        })
      }
    })
  }

  const usageTurnIds = new Set<string>()
  const numberedTurnIds = new Set<string>()
  const turnOrdinals = new Set<number>()
  const currencies = new Set<string>()
  state.usage.forEach((usage, index) => {
    const ordinal = usage.accounting?.turn?.ordinal
    if (ordinal !== undefined) {
      if (turnOrdinals.has(ordinal)) {
        context.addIssue({ code: "custom", path: ["usage", index, "accounting", "turn", "ordinal"], message: "Transferred turn ordinals must be unique" })
      }
      turnOrdinals.add(ordinal)
      numberedTurnIds.add(usage.turnId)
    }
    if (usageTurnIds.has(usage.turnId)) {
      context.addIssue({ code: "custom", path: ["usage", index, "turnId"], message: "Transferred usage turn IDs must be unique" })
    }
    usageTurnIds.add(usage.turnId)
    if (usage.costSource === "provider-reported") currencies.add(usage.currency)
  })
  state.thread.forEach((item, index) => {
    if (item.turnId && !numberedTurnIds.has(item.turnId)) {
      context.addIssue({ code: "custom", path: ["thread", index, "turnId"], message: "Transferred turn links require a durable turn record" })
    }
  })
  if (currencies.size > 1) {
    context.addIssue({
      code: "custom",
      path: ["usage"],
      message: "Transferred usage cannot mix currencies within one session",
    })
  }
})

export const sessionTransferPreviewRefusalSchema = z.union([
  sessionTransferContractRefusalSchema,
  sourceRefusalSchema,
  transferRefusalSchema,
])

const previewCommon = {
  contractVersion: sessionTransferContractVersionSchema,
  sessionId: z.string().trim().min(1).check(utf16MaxLength(128)),
  sourceMachineId: machineIdSchema,
  targetMachineId: machineIdSchema,
  coverage: sessionTransferCoverageSchema,
} as const

export const sessionTransferPreviewSchema = z.discriminatedUnion("allowed", [
  z.object({
    ...previewCommon,
    allowed: z.literal(true),
    intentDigest: sessionTransferIntentDigestSchema,
    project: z.object({
      sourceProjectId: z.string().trim().min(1).check(utf16MaxLength(512)),
      targetProjectId: z.string().trim().min(1).check(utf16MaxLength(512)),
      lineageCommit: commitShaSchema,
      sourceHeadCommit: commitShaSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...previewCommon,
    allowed: z.literal(false),
    reason: sessionTransferPreviewRefusalSchema,
  }).strict(),
])

export type SessionTransferRuntime = z.infer<typeof sessionTransferRuntimeSchema>
export type SessionTransferForkOrigin = z.infer<typeof sessionTransferForkOriginSchema>
export type SessionTransferSession = z.infer<typeof sessionTransferSessionSchema>
export type SessionTransferUsageRecord = z.infer<typeof sessionTransferUsageRecordSchema>
export type SessionTransferState = z.infer<typeof sessionTransferStateSchema>
export type SessionTransferIncludedKind = z.infer<typeof sessionTransferIncludedKindSchema>
export type SessionTransferExcludedKind = z.infer<typeof sessionTransferExcludedKindSchema>
export type SessionTransferWarningKind = z.infer<typeof sessionTransferWarningKindSchema>
export type SessionTransferCoverage = z.infer<typeof sessionTransferCoverageSchema>
export type SessionTransferPreviewRefusal = z.infer<typeof sessionTransferPreviewRefusalSchema>
export type SessionTransferPreview = z.infer<typeof sessionTransferPreviewSchema>
