import { z } from "zod"

import { clientIdentityIdSchema, commitShaSchema, machineIdSchema } from "./identifiers.js"
import { clientKindSchema, type SessionSummary } from "./schema.js"
import { transferRefusalSchema } from "./transfer-preflight.js"
import { transferStreamRefusalSchema } from "./transfer-stream.js"
import { sessionTransferContractRefusalSchema } from "./transfer-contract-refusals.js"

export const transferMethodSchema = z.enum(["git-bundle", "remote-ref"])

export const transferStepSchema = z.enum([
  "create-recovery-checkpoint",
  "commit-session-checkpoint",
  "bundle-incremental",
  "stream-to-target",
  "push-session-ref",
  "fetch-on-target",
  "restore-on-target",
  "record-receipt",
])

export const sourceRefusalSchema = z.enum([
  "session-turn-active",
  "session-archived",
  "session-has-no-worktree",
  "session-recovery-unresolved",
])

export type SourceRefusal = z.infer<typeof sourceRefusalSchema>

export const sourceRefusalMessage: Record<SourceRefusal, string> = {
  "session-turn-active": "This session is mid turn, so it cannot move until the turn settles",
  "session-archived": "This session is archived, so there is nothing left to move",
  "session-has-no-worktree": "This session has no worktree, so there is nothing to move",
  "session-recovery-unresolved": "Confirm the earlier target's ownership before moving this recovered session",
}
export type TransferMethod = z.infer<typeof transferMethodSchema>
export type TransferStep = z.infer<typeof transferStepSchema>

export type SourcePreflight =
  | { allowed: true }
  | { allowed: false; reason: SourceRefusal }

export function sourcePreflight(input: { session: SessionSummary }): SourcePreflight {
  const { session } = input
  // A session must not move out from under a running agent, so the source is
  // only ready once its turn has settled.
  if (session.activeTurnId || session.state === "active" || session.state === "waiting") {
    return { allowed: false, reason: "session-turn-active" }
  }
  if (session.state === "archiving" || session.state === "archived") {
    return { allowed: false, reason: "session-archived" }
  }
  if (session.sourceRecovery) {
    return { allowed: false, reason: "session-recovery-unresolved" }
  }
  if (!session.workspacePath) return { allowed: false, reason: "session-has-no-worktree" }
  return { allowed: true }
}

// The incremental bundle is the default because repository bytes travel
// daemon to daemon. Pushing a Domovoi ref puts them on a remote the user did
// not necessarily choose, so it is opt-in.
const bundleSteps: TransferStep[] = [
  "create-recovery-checkpoint",
  "commit-session-checkpoint",
  "bundle-incremental",
  "stream-to-target",
  "restore-on-target",
  "record-receipt",
]

const remoteRefSteps: TransferStep[] = [
  "create-recovery-checkpoint",
  "commit-session-checkpoint",
  "push-session-ref",
  "fetch-on-target",
  "restore-on-target",
  "record-receipt",
]

export type TransferPlan = {
  sessionId: string
  sourceMachineId: string
  targetMachineId: string
  method: TransferMethod
  steps: TransferStep[]
}

export function planTransfer(input: {
  session: SessionSummary
  sourceMachineId: string
  targetMachineId: string
  method?: TransferMethod
}): TransferPlan {
  if (input.targetMachineId === input.sourceMachineId) throw new Error("target-is-source")
  const source = sourcePreflight({ session: input.session })
  if (!source.allowed) throw new Error(source.reason)

  const method = input.method ?? "git-bundle"
  return {
    sessionId: input.session.id,
    sourceMachineId: input.sourceMachineId,
    targetMachineId: input.targetMachineId,
    method,
    steps: method === "git-bundle" ? [...bundleSteps] : [...remoteRefSteps],
  }
}

export const transferReceiptSchema = z.object({
  sessionId: z.string().min(1),
  sourceMachineId: machineIdSchema,
  targetMachineId: machineIdSchema,
  method: transferMethodSchema,
  checkpointId: z.string().min(1),
  checkpointCommit: commitShaSchema,
  // The source keeps its recovery checkpoint, so a transfer can always be
  // undone from the machine that sent it. A receipt cannot say otherwise.
  recoveryCheckpointRetained: z.literal(true),
  outcome: z.enum(["succeeded", "failed", "refused", "source-recovered"]),
  // A transfer can be refused before it starts, or by the target once the
  // bytes arrive, and a receipt records whichever it was.
  reason: z.union([
    transferRefusalSchema,
    sourceRefusalSchema,
    transferStreamRefusalSchema,
    sessionTransferContractRefusalSchema,
    z.literal("target-ownership-unconfirmed"),
  ]).optional(),
  decidedBy: z.object({
    client: clientKindSchema,
    clientId: clientIdentityIdSchema.optional(),
  }).strict(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((receipt, context) => {
  if (receipt.outcome === "succeeded" && receipt.reason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A successful transfer cannot record a refusal reason",
    })
  }
  if (
    (receipt.outcome === "failed" || receipt.outcome === "refused")
    && receipt.reason === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "An unsuccessful transfer must record its reason",
    })
  }
  if (
    receipt.outcome === "source-recovered"
    && receipt.reason !== "target-ownership-unconfirmed"
  ) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Source recovery must name its unconfirmed ownership risk",
    })
  }
  if (
    receipt.outcome !== "source-recovered"
    && receipt.reason === "target-ownership-unconfirmed"
  ) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Only an explicit source recovery can record unconfirmed ownership",
    })
  }
})

export type TransferReceipt = z.infer<typeof transferReceiptSchema>
