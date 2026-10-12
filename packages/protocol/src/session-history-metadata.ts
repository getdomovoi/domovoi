import { z } from "zod"
import { utf16MaxLength } from "./validation.js"

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
  // Taken when a person allows a gated command, before the agent hears the
  // decision (J34).
  "before-approved-command",
])
export type CheckpointReason = z.infer<typeof checkpointReasonSchema>

// Matching consecutive staging passes is an observation, not an atomic
// snapshot: a write that reverts between passes cannot be detected.
export const midTurnCheckpointSchema = z.object({
  providerTurnId: z.string().min(1).check(utf16MaxLength(1_024)),
  stability: z.enum(["matched", "unstable"]),
  // Do not trim: whitespace is legal in a Git path.
  changedPaths: z.array(z.string().min(1).check(utf16MaxLength(4_096))).max(100_000),
}).strict().refine((capture) => (capture.stability === "matched") === (capture.changedPaths.length === 0), {
  path: ["changedPaths"],
  message: "Unstable captures name changed paths; matching captures have none",
})
export type MidTurnCheckpoint = z.infer<typeof midTurnCheckpointSchema>


// Wall-clock time from the approval request to its resolution. This is consent
// latency, never the execution duration of the approved operation.
export const approvalDecisionDurationMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

// Wall-clock time from the decision to the provider reporting the allowed
// command's item complete. Absent when no completion was seen for that item.
export const approvedCommandRunMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

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
