import { z } from "zod"

import { utf16MaxLength, wireRule } from "./validation.js"

// J34: a person's allow takes a checkpoint first, and when the daemon cannot
// take one the command does not run and the gate stays. approval.resolve then
// answers with this code, the daemon's sentence as the message, and an
// approvalCheckpointRefusalSchema as the data, so a client can say why
// without reading the sentence.
export const approvalCheckpointErrorCode = -32023 as const

// What the daemon can tell apart when the checkpoint fails, and nothing finer:
// - lock-held: Git said a lock file it needed already exists, and the lock
//   lies in the worktree's own Git directories. The daemon cannot tell a
//   running Git's lock from one a stopped Git left.
// - submodule-changes: a submodule has local changes a checkpoint, which
//   records a submodule by its commit, cannot hold.
// - repository-config: the repository's own Git config asks for something
//   Domovoi will not run here (an untrusted filter, a submodule's own filter,
//   a partial clone's promisor). The message names the setting.
// - repository-config-unreadable: Git could not read the repository's config,
//   so what it sets is unknown.
// - git-unavailable: Git is missing, or its version is too old or could not
//   be read.
// - timed-out: the checkpoint did not finish before the daemon's deadline.
// - git-failed: a Git command failed for any other reason.
// - unknown: something else failed, and the daemon cannot say what.
export const approvalCheckpointRefusalCauses = [
  "lock-held",
  "submodule-changes",
  "repository-config",
  "repository-config-unreadable",
  "git-unavailable",
  "timed-out",
  "git-failed",
  "unknown",
] as const

export const maximumApprovalCheckpointLockPathLength = 4_096

const controlCharacter = /[\p{Cc}\p{Zl}\p{Zp}]/u
const absolutePath = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u

// The lock as Git reported it: an absolute path ending in .lock, on the
// machine that ran the command, on one line.
// Each refine declares what it captures, so the wire record sees it.
const lockSuffix = ".lock"
const boundedLockPath = z.string().min(1).check(utf16MaxLength(maximumApprovalCheckpointLockPathLength))
const absoluteLockPath = wireRule(
  boundedLockPath.refine((path) => absolutePath.test(path), { message: "A lock path is absolute" }),
  { rule: "lock-path-absolute", pattern: absolutePath.source },
)
const lockFilePath = wireRule(
  absoluteLockPath.refine((path) => path.endsWith(lockSuffix), { message: "A lock path names a .lock file" }),
  { rule: "lock-path-suffix", suffix: lockSuffix },
)
const lockPathSchema = wireRule(
  lockFilePath.refine((path) => !controlCharacter.test(path), { message: "A lock path holds no control characters" }),
  { rule: "lock-path-one-line", pattern: controlCharacter.source },
)

export const approvalCheckpointRefusalSchema = z.union([
  z.object({
    kind: z.literal("approval-checkpoint-refused"),
    cause: z.literal("lock-held"),
    lockPath: lockPathSchema,
  }).strict(),
  z.object({
    kind: z.literal("approval-checkpoint-refused"),
    cause: z.enum(approvalCheckpointRefusalCauses).exclude(["lock-held"]),
  }).strict(),
])

export type ApprovalCheckpointRefusalCause = typeof approvalCheckpointRefusalCauses[number]
export type ApprovalCheckpointRefusal = z.infer<typeof approvalCheckpointRefusalSchema>
