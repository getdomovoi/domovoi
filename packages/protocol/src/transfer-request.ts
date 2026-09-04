import { z } from "zod"

import { commitShaSchema, machineIdSchema, transferIdSchema } from "./identifiers.js"
import { clientKindSchema, workspaceSnapshotSchema } from "./schema.js"
import {
  sessionTransferContractRefusalMessage,
  sessionTransferContractRefusalSchema,
  sessionTransferContractVersionSchema,
  sessionTransferCoverageSchema,
  sessionTransferIntentDigestSchema,
  type SessionTransferContractRefusal,
} from "./transfer-contract.js"
import { sourceRefusalMessage, sourceRefusalSchema, transferMethodSchema, type SourceRefusal } from "./transfer.js"
import { transferRefusalMessage, transferRefusalSchema, type TransferRefusal } from "./transfer-preflight.js"
import {
  transferStreamRefusalMessage,
  transferStreamRefusalSchema,
  type TransferStreamRefusal,
} from "./transfer-stream.js"
import {
  transferFailureReasonSchema,
  transferRecoveryStageSchema,
} from "./transfer-transaction.js"

// A remote name reaches git, where a leading dash would be read as an option.
export const gitRemoteNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(128)

const sessionTransferRequestFields = {
  sessionId: z.string().trim().min(1).max(128),
  targetMachineId: machineIdSchema,
  client: clientKindSchema,
  // The bundle keeps repository bytes on the machines involved, so it is what
  // happens unless the caller deliberately asks for the remote.
  method: transferMethodSchema.default("git-bundle"),
  remote: gitRemoteNameSchema.optional(),
} as const

function validateTransferMethod(
  params: { method: "git-bundle" | "remote-ref", remote?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (params.method === "remote-ref" && params.remote === undefined) {
    context.addIssue({
      code: "custom",
      path: ["remote"],
      message: "The remote ref path needs the remote to push to",
    })
  }
  if (params.method === "git-bundle" && params.remote !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["remote"],
      message: "A bundle transfer does not use a remote",
    })
  }
}

export const sessionTransferPreviewParamsSchema = z.object(sessionTransferRequestFields)
  .strict()
  .superRefine(validateTransferMethod)

export const sessionTransferParamsSchema = z.object({
  ...sessionTransferRequestFields,
  contractVersion: sessionTransferContractVersionSchema.optional(),
  intentDigest: sessionTransferIntentDigestSchema.optional(),
}).strict().superRefine((params, context) => {
  validateTransferMethod(params, context)
  if ((params.contractVersion === undefined) !== (params.intentDigest === undefined)) {
    context.addIssue({
      code: "custom",
      path: params.contractVersion === undefined ? ["contractVersion"] : ["intentDigest"],
      message: "A transfer contract version and preview intent digest must be sent together",
    })
  }
})

export const transferFromRefParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  remote: gitRemoteNameSchema,
  client: clientKindSchema,
}).strict()

export const sessionTransferRecoverSourceParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  transferId: transferIdSchema,
  confirmation: z.literal("target-does-not-have-session"),
  client: clientKindSchema,
}).strict()

export const sessionTransferRecoverSourceResultSchema = workspaceSnapshotSchema

export const transferFromRefResultSchema = z.object({
  workspacePath: z.string().min(1),
  checkpointCommit: commitShaSchema,
}).strict()

const succeededTransferResultSchema = z.object({
  outcome: z.literal("succeeded"),
  workspacePath: z.string().min(1),
  checkpointCommit: commitShaSchema,
  contractVersion: sessionTransferContractVersionSchema.optional(),
  transferId: transferIdSchema.optional(),
  ownershipGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  coverage: sessionTransferCoverageSchema.optional(),
}).strict().superRefine((result, context) => {
  const versionedFields = [
    result.contractVersion,
    result.transferId,
    result.ownershipGeneration,
    result.coverage,
  ]
  const count = versionedFields.filter((field) => field !== undefined).length
  if (count !== 0 && count !== versionedFields.length) {
    context.addIssue({
      code: "custom",
      path: ["contractVersion"],
      message: "A versioned transfer result must carry all ownership and coverage fields",
    })
  }
})

const refusedTransferResultSchema = z.object({
  // A refusal always says why, because the answer decides what the operator
  // does next: pick another machine, or wait for a turn to finish.
  outcome: z.literal("refused"),
  reason: z.union([
    transferRefusalSchema,
    sourceRefusalSchema,
    transferStreamRefusalSchema,
    sessionTransferContractRefusalSchema,
  ]),
}).strict()

export const sessionTransferResultSchema = z.union([
  succeededTransferResultSchema,
  refusedTransferResultSchema,
  z.object({ outcome: z.literal("failed") }).strict(),
  z.object({
    outcome: z.literal("incomplete"),
    transferId: transferIdSchema,
    state: z.literal("unknown"),
    recoveryAction: z.literal("check-status"),
  }).strict(),
  z.object({
    outcome: z.literal("incomplete"),
    transferId: transferIdSchema,
    state: z.literal("receiving"),
    recoveryAction: z.literal("resume"),
  }).strict(),
  z.object({
    outcome: z.literal("incomplete"),
    transferId: transferIdSchema,
    state: z.literal("prepared"),
    recoveryAction: z.literal("resume"),
  }).strict(),
  z.object({
    outcome: z.literal("incomplete"),
    transferId: transferIdSchema,
    state: z.literal("recovering"),
    stage: transferRecoveryStageSchema,
    recoveryAction: z.literal("none"),
  }).strict(),
  z.object({
    outcome: z.literal("incomplete"),
    transferId: transferIdSchema,
    state: z.literal("failed"),
    reason: transferFailureReasonSchema,
    recoveryAction: z.literal("retry"),
  }).strict(),
  z.object({
    outcome: z.literal("incomplete"),
    transferId: transferIdSchema,
    state: z.literal("ownership-unconfirmed"),
    recoveryAction: z.literal("confirm-source-recovery"),
  }).strict(),
  z.object({
    outcome: z.literal("incomplete"),
    transferId: transferIdSchema,
    state: z.literal("ownership-conflict"),
    recoveryAction: z.literal("none"),
  }).strict(),
])

export type SessionTransferPreviewParams = z.infer<typeof sessionTransferPreviewParamsSchema>
export type SessionTransferParams = z.infer<typeof sessionTransferParamsSchema>
export type SessionTransferResult = z.infer<typeof sessionTransferResultSchema>
export type SessionTransferRecoverSourceParams = z.infer<
  typeof sessionTransferRecoverSourceParamsSchema
>
export type SessionTransferRecoverSourceResult = z.infer<
  typeof sessionTransferRecoverSourceResultSchema
>
export type TransferFromRefParams = z.infer<typeof transferFromRefParamsSchema>
export type TransferFromRefResult = z.infer<typeof transferFromRefResultSchema>

export type SessionTransferRefusal =
  | TransferRefusal
  | SourceRefusal
  | TransferStreamRefusal
  | SessionTransferContractRefusal

const sessionTransferRefusalMessages: Record<SessionTransferRefusal, string> = {
  ...transferRefusalMessage,
  ...sourceRefusalMessage,
  ...transferStreamRefusalMessage,
  ...sessionTransferContractRefusalMessage,
}

// A refused move is only useful if it says what to do next, so the reason the
// daemon answered with is carried through to the operator verbatim.
export function sessionTransferRefusalMessage(reason: SessionTransferRefusal): string {
  return sessionTransferRefusalMessages[reason]
}
