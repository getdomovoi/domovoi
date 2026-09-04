import { z } from "zod"

import {
  canonicalBase64DecodedByteLength,
  clientKindSchema,
  commitShaSchema,
  machineIdSchema,
  sha256DigestSchema,
  transferIdSchema,
} from "./identifiers.js"
import {
  sessionTransferContractRefusalSchema,
  sessionTransferContractVersionSchema,
  sessionTransferCoverageSchema,
  sessionTransferIntentDigestSchema,
} from "./transfer-contract.js"
import {
  maximumTransferBytes,
  transferChunkSchema,
  transferStreamRefusalSchema,
} from "./transfer-stream.js"
import { transferMethodSchema } from "./transfer.js"

export const sessionTransferManifestDomain = "domovoi.session-transfer-manifest.v1\0" as const
export const sessionTransferMemberIdSchema = z.string().regex(/^[a-z][a-z0-9:._-]{0,255}$/)
export const transferMemberChunkBytes = 262_144

const memberCommon = {
  memberId: sessionTransferMemberIdSchema,
  digest: sha256DigestSchema,
  byteLength: z.number().int().nonnegative().max(maximumTransferBytes),
} as const

export const sessionTransferMemberSchema = z.discriminatedUnion("kind", [
  z.object({
    ...memberCommon,
    kind: z.literal("session-state"),
  }).strict().refine((member) => member.byteLength > 0, {
    path: ["byteLength"],
    message: "Session state cannot be empty",
  }),
  z.object({
    ...memberCommon,
    kind: z.literal("repository-bundle"),
  }).strict().refine((member) => member.byteLength > 0, {
    path: ["byteLength"],
    message: "A repository bundle cannot be empty",
  }),
  z.object({
    ...memberCommon,
    kind: z.literal("artifact-source"),
    artifactId: z.string().trim().min(1).max(512),
  }).strict(),
  z.object({
    ...memberCommon,
    kind: z.literal("annotation-crop"),
    ref: z.string().regex(/^crop-[a-f0-9]{64}$/),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  }).strict().refine((member) => member.byteLength > 0, {
    path: ["byteLength"],
    message: "An annotation crop cannot be empty",
  }),
])

const gitRemoteNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(128)
const sessionRefSchema = z.string().regex(/^refs\/domovoi\/sessions\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)

export const sessionTransferRepositorySchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("git-bundle"),
    memberId: sessionTransferMemberIdSchema,
  }).strict(),
  z.object({
    method: z.literal("remote-ref"),
    remote: gitRemoteNameSchema,
    ref: sessionRefSchema,
    commit: commitShaSchema,
  }).strict(),
])

const safeGenerationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const sessionTransferTargetRefusalSchema = z.enum([
  "target-project-missing",
  "target-project-mismatch",
  "target-session-newer",
  "target-session-diverged",
  "target-lineage-check-unavailable",
  "target-bundle-restore-unavailable",
  "target-ref-restore-unavailable",
  "target-artifact-import-unavailable",
  "target-usage-import-unavailable",
  "target-state-persistence-unavailable",
])

export const sessionTransferTargetConflictReasonSchema = z.enum([
  "target-session-newer",
  "target-session-diverged",
])
const sessionTransferTargetNonConflictRefusalSchema = sessionTransferTargetRefusalSchema.exclude([
  "target-session-newer",
  "target-session-diverged",
])

export const transferTargetPreflightParamsSchema = z.object({
  contractVersion: sessionTransferContractVersionSchema,
  sessionId: z.string().trim().min(1).max(128),
  sourceMachineId: machineIdSchema,
  sourceProjectId: z.string().trim().min(1).max(512),
  lineageCommit: commitShaSchema,
  ownershipGeneration: safeGenerationSchema,
  method: transferMethodSchema,
  coverage: sessionTransferCoverageSchema,
  initiatedByClient: clientKindSchema,
}).strict()

export const transferTargetPreflightResultSchema = z.union([
  z.object({
    allowed: z.literal(true),
    targetProjectId: z.string().trim().min(1).max(512),
    lineageCommit: commitShaSchema,
  }).strict(),
  z.object({
    allowed: z.literal(false),
    reason: sessionTransferTargetNonConflictRefusalSchema,
  }).strict(),
  z.object({
    allowed: z.literal(false),
    reason: sessionTransferTargetConflictReasonSchema,
    existingGeneration: safeGenerationSchema,
  }).strict(),
])

export const sessionTransferManifestSchema = z.object({
  version: sessionTransferContractVersionSchema,
  transferId: transferIdSchema,
  sessionId: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  sourceMachineId: machineIdSchema,
  targetMachineId: machineIdSchema,
  intentDigest: sessionTransferIntentDigestSchema,
  createdAt: z.string().datetime({ offset: true }),
  ownership: z.object({
    fromGeneration: safeGenerationSchema,
    toGeneration: safeGenerationSchema,
  }).strict(),
  project: z.object({
    sourceProjectId: z.string().trim().min(1).max(512),
    targetProjectId: z.string().trim().min(1).max(512),
    lineageCommit: commitShaSchema,
    checkpointCommit: commitShaSchema,
  }).strict(),
  repository: sessionTransferRepositorySchema,
  stateMemberId: sessionTransferMemberIdSchema,
  members: z.array(sessionTransferMemberSchema).min(1).max(1_024),
  totalBytes: z.number().int().positive().max(maximumTransferBytes),
  coverage: sessionTransferCoverageSchema,
}).strict().superRefine((manifest, context) => {
  if (manifest.ownership.toGeneration !== manifest.ownership.fromGeneration + 1) {
    context.addIssue({
      code: "custom",
      path: ["ownership", "toGeneration"],
      message: "A transfer must advance ownership by one generation",
    })
  }
  if (manifest.sourceMachineId === manifest.targetMachineId) {
    context.addIssue({
      code: "custom",
      path: ["targetMachineId"],
      message: "A session cannot transfer to its current machine",
    })
  }

  const memberIds = new Set<string>()
  manifest.members.forEach((member, index) => {
    if (memberIds.has(member.memberId)) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "memberId"],
        message: "Transfer member IDs must be unique",
      })
    }
    memberIds.add(member.memberId)
  })
  const stateMember = manifest.members.find((member) => member.memberId === manifest.stateMemberId)
  if (stateMember?.kind !== "session-state") {
    context.addIssue({
      code: "custom",
      path: ["stateMemberId"],
      message: "The state member must name declared session state",
    })
  }

  const repositoryMembers = manifest.members.filter((member) => member.kind === "repository-bundle")
  if (manifest.repository.method === "git-bundle") {
    const repositoryMemberId = manifest.repository.memberId
    const repositoryMember = manifest.members.find(
      (member) => member.memberId === repositoryMemberId,
    )
    if (repositoryMember?.kind !== "repository-bundle" || repositoryMembers.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["repository", "memberId"],
        message: "Bundle transport requires exactly one declared repository bundle",
      })
    }
  } else {
    if (repositoryMembers.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "Remote-ref transport cannot also stream a repository bundle",
      })
    }
    if (
      manifest.repository.ref !== `refs/domovoi/sessions/${manifest.sessionId}`
      || manifest.repository.commit !== manifest.project.checkpointCommit
    ) {
      context.addIssue({
        code: "custom",
        path: ["repository"],
        message: "The remote ref must name this session checkpoint",
      })
    }
  }

  const totalBytes = manifest.members.reduce((total, member) => total + member.byteLength, 0)
  if (totalBytes !== manifest.totalBytes) {
    context.addIssue({
      code: "custom",
      path: ["totalBytes"],
      message: "Transfer byte count must equal the declared members",
    })
  }
})

export const sessionTransferManifestDigestSchema = sha256DigestSchema
export const sessionTransferTransactionRefusalSchema = z.union([
  sessionTransferContractRefusalSchema,
  transferStreamRefusalSchema,
])
const sessionTransferTransactionNonConflictRefusalSchema = z.union([
  sessionTransferContractRefusalSchema.exclude([
    "target-session-newer",
    "target-session-diverged",
  ]),
  transferStreamRefusalSchema,
])

const transactionCommon = {
  transferId: transferIdSchema,
} as const
const committedFields = {
  ...transactionCommon,
  workspacePath: z.string().min(1),
  checkpointCommit: commitShaSchema,
  ownershipGeneration: safeGenerationSchema,
} as const

export const transferPrepareParamsSchema = z.object({
  manifest: sessionTransferManifestSchema,
  manifestDigest: sessionTransferManifestDigestSchema,
  initiatedByClient: clientKindSchema,
}).strict()

export const transferPrepareResultSchema = z.union([
  z.object({
    ...transactionCommon,
    state: z.literal("receiving"),
    missingMemberIds: z.array(sessionTransferMemberIdSchema).max(1_024),
  }).strict(),
  z.object({ ...transactionCommon, state: z.literal("prepared") }).strict(),
  z.object({ ...committedFields, state: z.literal("committed") }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("refused"),
    reason: sessionTransferTransactionNonConflictRefusalSchema,
  }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("refused"),
    reason: sessionTransferTargetConflictReasonSchema,
    existingGeneration: safeGenerationSchema,
  }).strict(),
])

export const transferMemberParamsSchema = transferChunkSchema.extend({
  transferId: transferIdSchema,
  memberId: sessionTransferMemberIdSchema,
  initiatedByClient: clientKindSchema,
}).strict().superRefine((request, context) => {
  if (request.final) return
  if (canonicalBase64DecodedByteLength(request.bytes) === transferMemberChunkBytes) return
  // Full non-final chunks make the journal entry count a function of the
  // manifest's bounded byte total. Without this, a sender could consume
  // unbounded inodes and quadratic scans with tiny or empty fragments.
  context.addIssue({
    code: "custom",
    path: ["bytes"],
    message: `Non-final transfer member chunks must contain ${transferMemberChunkBytes} bytes`,
  })
})

export const transferMemberResultSchema = z.discriminatedUnion("state", [
  z.object({
    ...transactionCommon,
    state: z.literal("receiving"),
    memberId: sessionTransferMemberIdSchema,
    nextSequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("member-received"),
    memberId: sessionTransferMemberIdSchema,
  }).strict(),
  z.object({ ...transactionCommon, state: z.literal("prepared") }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("refused"),
    reason: sessionTransferTransactionRefusalSchema,
  }).strict(),
])

const transactionRequest = {
  transferId: transferIdSchema,
  manifestDigest: sessionTransferManifestDigestSchema,
  initiatedByClient: clientKindSchema,
} as const

export const transferCommitParamsSchema = z.object(transactionRequest).strict()
export const transferCommitResultSchema = z.union([
  z.object({ ...committedFields, state: z.literal("committed") }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("refused"),
    reason: sessionTransferTransactionNonConflictRefusalSchema,
  }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("refused"),
    reason: sessionTransferTargetConflictReasonSchema,
    existingGeneration: safeGenerationSchema,
  }).strict(),
])

export const transferRecoveryStageSchema = z.enum([
  "repository",
  "state",
  "resources",
  "persistence",
])
export const transferFailureReasonSchema = z.enum([
  "repository-restore-failed",
  "state-import-failed",
  "resource-import-failed",
  "persistence-failed",
  "recovery-failed",
])

export const transferStatusParamsSchema = z.object(transactionRequest).strict()
export const transferStatusResultSchema = z.discriminatedUnion("state", [
  z.object({ ...transactionCommon, state: z.literal("unknown") }).strict(),
  z.object({ ...transactionCommon, state: z.literal("receiving") }).strict(),
  z.object({ ...transactionCommon, state: z.literal("prepared") }).strict(),
  z.object({ ...committedFields, state: z.literal("committed") }).strict(),
  z.object({ ...transactionCommon, state: z.literal("aborted") }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("recovering"),
    stage: transferRecoveryStageSchema,
  }).strict(),
  z.object({
    ...transactionCommon,
    state: z.literal("failed"),
    reason: transferFailureReasonSchema,
  }).strict(),
])

export const transferAbortParamsSchema = z.object(transactionRequest).strict()
export const transferAbortResultSchema = z.discriminatedUnion("state", [
  z.object({ ...transactionCommon, state: z.literal("aborted") }).strict(),
  z.object({ ...committedFields, state: z.literal("committed") }).strict(),
])

export type SessionTransferMember = z.infer<typeof sessionTransferMemberSchema>
export type SessionTransferRepository = z.infer<typeof sessionTransferRepositorySchema>
export type SessionTransferTargetRefusal = z.infer<typeof sessionTransferTargetRefusalSchema>
export type TransferTargetPreflightParams = z.infer<typeof transferTargetPreflightParamsSchema>
export type TransferTargetPreflightResult = z.infer<typeof transferTargetPreflightResultSchema>
export type SessionTransferManifest = z.infer<typeof sessionTransferManifestSchema>
export type SessionTransferTransactionRefusal = z.infer<typeof sessionTransferTransactionRefusalSchema>
export type TransferPrepareParams = z.infer<typeof transferPrepareParamsSchema>
export type TransferPrepareResult = z.infer<typeof transferPrepareResultSchema>
export type TransferMemberParams = z.infer<typeof transferMemberParamsSchema>
export type TransferMemberResult = z.infer<typeof transferMemberResultSchema>
export type TransferCommitParams = z.infer<typeof transferCommitParamsSchema>
export type TransferCommitResult = z.infer<typeof transferCommitResultSchema>
export type TransferStatusParams = z.infer<typeof transferStatusParamsSchema>
export type TransferStatusResult = z.infer<typeof transferStatusResultSchema>
export type TransferAbortParams = z.infer<typeof transferAbortParamsSchema>
export type TransferAbortResult = z.infer<typeof transferAbortResultSchema>
