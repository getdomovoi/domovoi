import { approvalCheckpointRefusalSchema, type ApprovalCheckpointRefusal } from "@getdomovoi/protocol"

import { GitNotFoundError } from "./git-command.js"
import { GitTooOldForIsolationError } from "./isolated-checkout.js"
import { RepositoryGitConfigUnreadableError } from "./repository-git-filters.js"
import { RepositoryConfigRefusedError, SubmoduleChangesRefusedError } from "./workspace.js"

export type ApprovalCheckpointRefusalAnswer = {
  message: string
  data: ApprovalCheckpointRefusal
}

const refused = "Domovoi could not take a checkpoint, so the command did not run; decide again"

// Git's own words when a lock file it needs is already there (lockfile.c,
// unable_to_lock_message with EEXIST): the path it names ends in .lock. Git
// prints them in English unless it was built with translations and a locale
// asks for another language; then the failure stays a plain Git failure.
const heldLockPattern = /Unable to create '([^'\n]+\.lock)': File exists\./u

// How far down an error's causes the Git failure is looked for: the
// workspace wraps a Git failure once or twice at most.
const maximumCauseDepth = 4

// Why a checkpoint taken before an approved command failed, from what the
// daemon observed, and the sentence an older client shows instead. A cause
// the daemon cannot vouch for is never named: an unreadable lock path is a
// Git failure, and an error that is not Git's is unknown.
export function approvalCheckpointRefusal(error: unknown, options: { timedOut: boolean }): ApprovalCheckpointRefusalAnswer {
  const answer = (data: ApprovalCheckpointRefusal, message: string): ApprovalCheckpointRefusalAnswer => ({
    message,
    data: approvalCheckpointRefusalSchema.parse(data),
  })
  const kind = "approval-checkpoint-refused" as const
  if (options.timedOut) {
    return answer({ kind, cause: "timed-out" }, "Domovoi could not take a checkpoint in time, so the command did not run; decide again")
  }
  if (error instanceof SubmoduleChangesRefusedError) {
    return answer(
      { kind, cause: "submodule-changes" },
      "Domovoi could not take a checkpoint: a submodule has local changes a checkpoint cannot hold, so the command did not run",
    )
  }
  if (error instanceof RepositoryConfigRefusedError || error instanceof RepositoryGitConfigUnreadableError) {
    return answer({ kind, cause: "repository-config" }, `${refused}. ${error.message}`)
  }
  if (error instanceof GitNotFoundError || error instanceof GitTooOldForIsolationError) {
    return answer({ kind, cause: "git-unavailable" }, `${refused}. ${error.message}`)
  }
  const failure = gitFailureIn(error)
  if (failure === undefined) return answer({ kind, cause: "unknown" }, refused)
  const lockPath = heldLockPattern.exec(failure)?.[1]
  const held = lockPath === undefined
    ? undefined
    : approvalCheckpointRefusalSchema.safeParse({ kind, cause: "lock-held", lockPath })
  if (held?.success === true && held.data.cause === "lock-held") {
    return answer(held.data, `Domovoi could not take a checkpoint: ${held.data.lockPath} is held by another git process, so the command did not run; decide again`)
  }
  return answer({ kind, cause: "git-failed" }, "Domovoi could not take a checkpoint because a Git command failed, so the command did not run; decide again")
}

// The stderr of the first Git command failure in the error or its causes: a
// failed git run carries what Git printed as `stderr` and its exit status as
// a numeric `code` (execFile's shape, which isolated-checkout.ts keeps).
function gitFailureIn(error: unknown): string | undefined {
  let current = error
  for (let depth = 0; depth <= maximumCauseDepth && current instanceof Error; depth += 1) {
    const { stderr, code } = current as Error & { stderr?: unknown, code?: unknown }
    if (typeof stderr === "string" && typeof code === "number") return stderr
    current = current.cause
  }
  return undefined
}
