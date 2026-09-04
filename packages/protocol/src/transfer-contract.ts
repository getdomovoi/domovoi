import { z } from "zod"

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
import {
  sessionTransferContractRefusalMessage,
  sessionTransferContractRefusalSchema,
  type SessionTransferContractRefusal,
} from "./transfer-contract-refusals.js"

export {
  sessionTransferContractRefusalMessage,
  sessionTransferContractRefusalSchema,
  type SessionTransferContractRefusal,
} from "./transfer-contract-refusals.js"

export const sessionTransferContractVersion = 1 as const
export const sessionTransferContractVersionSchema = z.literal(sessionTransferContractVersion)
export const sessionTransferIntentDigestSchema = sha256DigestSchema

export const maximumSessionTransferThreadItems = 100_000
export const maximumSessionTransferArtifacts = 10_000
export const maximumSessionTransferAnnotations = 10_000
export const maximumSessionTransferUsageRecords = 100_000

const safeCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const sessionTransferRuntimeSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
  reasoning: reasoningEffortSchema,
  permissionMode: permissionModeSchema,
}).strict()

export const sessionTransferForkOriginSchema = sessionForkOriginSchema.extend({
  sourceMachineId: machineIdSchema,
}).strict()

export const sessionTransferSessionSchema = z.object({
  id: z.string().trim().min(1).max(128),
  title: z.string().min(1),
  runtime: sessionTransferRuntimeSchema,
  changedFiles: safeCounterSchema,
  testsPassed: safeCounterSchema,
  testsFailed: safeCounterSchema,
  updatedAt: z.string().datetime({ offset: true }),
  baseCommit: commitShaSchema,
  ownershipGeneration: safeCounterSchema,
  forkedFrom: sessionTransferForkOriginSchema.optional(),
  transferredFrom: sessionTransferOriginSchema.optional(),
}).strict()

const transferUsageBase = z.object({
  turnId: z.string().trim().min(1).max(256),
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(256),
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
  state.thread.forEach((item, index) => {
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
  const currencies = new Set<string>()
  state.usage.forEach((usage, index) => {
    if (usageTurnIds.has(usage.turnId)) {
      context.addIssue({ code: "custom", path: ["usage", index, "turnId"], message: "Transferred usage turn IDs must be unique" })
    }
    usageTurnIds.add(usage.turnId)
    if (usage.costSource === "provider-reported") currencies.add(usage.currency)
  })
  if (currencies.size > 1) {
    context.addIssue({
      code: "custom",
      path: ["usage"],
      message: "Transferred usage cannot mix currencies within one session",
    })
  }
})

export const sessionTransferIncludedKindSchema = z.enum([
  "repository",
  "thread",
  "checkpoints",
  "artifacts",
  "artifact-sources",
  "annotations",
  "annotation-crops",
  "working-plan",
  "usage",
  "runtime-settings",
])

export const sessionTransferExcludedKindSchema = z.enum([
  "provider-credentials",
  "provider-state",
  "terminals",
  "approval-rules",
  "skill-authority",
  "audit-log",
  "ignored-files",
  "external-databases",
  "auto",
])

export const sessionTransferWarningKindSchema = z.enum([
  "tracked-sensitive-files-may-travel",
  "promoted-ignored-artifacts",
  "provider-restart-required",
  "target-reapproval-required",
])

const coverageEntry = <Schema extends z.ZodType>(kind: Schema) => z.object({
  kind,
  count: safeCounterSchema.optional(),
}).strict()

function uniqueCoverage(
  entries: ReadonlyArray<{ kind: string }>,
  context: z.RefinementCtx,
): void {
  const kinds = new Set<string>()
  entries.forEach((entry, index) => {
    if (kinds.has(entry.kind)) {
      context.addIssue({ code: "custom", path: [index, "kind"], message: "Transfer coverage keys must be unique" })
    }
    kinds.add(entry.kind)
  })
}

export const sessionTransferCoverageSchema = z.object({
  included: z.array(coverageEntry(sessionTransferIncludedKindSchema)),
  excluded: z.array(coverageEntry(sessionTransferExcludedKindSchema)),
  warnings: z.array(coverageEntry(sessionTransferWarningKindSchema)),
}).strict().superRefine((coverage, context) => {
  uniqueCoverage(coverage.included, context)
  uniqueCoverage(coverage.excluded, context)
  uniqueCoverage(coverage.warnings, context)
})

export const sessionTransferPreviewRefusalSchema = z.union([
  sessionTransferContractRefusalSchema,
  sourceRefusalSchema,
  transferRefusalSchema,
])

const previewCommon = {
  contractVersion: sessionTransferContractVersionSchema,
  sessionId: z.string().trim().min(1).max(128),
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
      sourceProjectId: z.string().trim().min(1).max(512),
      targetProjectId: z.string().trim().min(1).max(512),
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
