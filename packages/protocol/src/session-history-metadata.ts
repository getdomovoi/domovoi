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

export const maximumMidTurnCheckpointTurnIdLength = 1_024
export const maximumMidTurnCheckpointPaths = 50
export const maximumMidTurnCheckpointPathLength = 4_096
// A full history page or retained thread holds up to 100 entries. Budget the
// serialized array, including JSON escaping and UTF-8 expansion, per capture.
export const maximumMidTurnCheckpointPathsBytes = 16 * 1_024

// Matching consecutive staging passes is an observation, not an atomic
// snapshot: a write that reverts between passes cannot be detected.
export const midTurnCheckpointSchema = z.object({
  // Keep the active-turn contract unchanged. Large IDs are represented by a
  // digest so repeated captures cannot overflow a history page or snapshot.
  providerTurnId: z.string().min(1).check(utf16MaxLength(maximumMidTurnCheckpointTurnIdLength)).optional(),
  providerTurnIdSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  stability: z.enum(["matched", "unstable"]),
  // Do not trim: whitespace is legal in a Git path.
  changedPaths: z.array(z.string().min(1).check(utf16MaxLength(maximumMidTurnCheckpointPathLength))).max(maximumMidTurnCheckpointPaths).refine(
    (paths) => new TextEncoder().encode(JSON.stringify(paths)).byteLength <= maximumMidTurnCheckpointPathsBytes,
    "Changed paths exceed their serialized byte budget",
  ),
  // Total distinct observed paths, including those omitted by either bound.
  changedPathCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((capture) => (capture.providerTurnId !== undefined) !== (capture.providerTurnIdSha256 !== undefined), {
  path: ["providerTurnId"],
  message: "A capture must contain either the provider turn ID or its SHA-256 digest",
}).refine((capture) => capture.changedPathCount >= capture.changedPaths.length, {
  path: ["changedPathCount"],
  message: "The changed-path count must include every displayed path",
}).refine((capture) => capture.stability !== "matched" || capture.changedPathCount === 0, {
  path: ["changedPathCount"],
  message: "Matching captures have no changed paths",
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
