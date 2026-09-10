import { z } from "zod"

import { commitShaSchema, machineIdSchema, transferIdSchema } from "./identifiers.js"
import { sessionTransferCoverageSchema } from "./transfer-coverage.js"

export const checkpointReasonSchema = z.enum([
  "session-start",
  "fork",
  "manual",
  "before-restore",
  "before-revert",
  "before-provider-handoff",
  "before-provider-recovery",
  "before-archive",
])
export type CheckpointReason = z.infer<typeof checkpointReasonSchema>

// Wall-clock time from the approval request to its resolution. This is consent
// latency, never the execution duration of the approved operation.
export const approvalDecisionDurationMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

// Only an acknowledged target commit emits this metadata. Refusal, recovery,
// and conflict release must not masquerade as a completed machine transfer.
export const sessionTransferHistorySchema = z.object({
  transferId: transferIdSchema,
  sourceMachineId: machineIdSchema,
  targetMachineId: machineIdSchema,
  checkpointCommit: commitShaSchema,
  outcome: z.literal("succeeded"),
  preflight: z.literal("passed"),
  // A transfer resumed from an older snapshot may not have retained coverage.
  // Missing coverage or a missing count means unknown, never zero.
  coverage: sessionTransferCoverageSchema.optional(),
}).strict().refine((transfer) => transfer.sourceMachineId !== transfer.targetMachineId, {
  path: ["targetMachineId"],
  message: "A session cannot transfer to its current machine",
})
