import { lstat, readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import { approvalCheckpointRefusalSchema, type ApprovalCheckpointRefusal } from "@getdomovoi/protocol"

import { GitNotFoundError } from "./git-command.js"
import { redactInventoryPath } from "./inventory-redaction.js"
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

// How far down an error's causes a failure is looked for: the workspace
// wraps a Git failure once or twice at most.
const maximumCauseDepth = 4

// Why a checkpoint taken before an approved command in `worktree` failed,
// from what the daemon observed, and the sentence an older client shows
// instead. A cause the daemon cannot vouch for is never named: a lock it
// cannot place in the worktree's own Git directories, or whose path the
// redactor would change, is a Git failure, and an error that is not Git's is
// unknown.
export async function approvalCheckpointRefusal(
  error: unknown,
  options: { timedOut: boolean, worktree: string },
): Promise<ApprovalCheckpointRefusalAnswer> {
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
  // Before the config reads: a Git that cannot start also fails the read of
  // the repository's config, which wraps the spawn's error.
  if (gitCouldNotStart(error)) {
    return answer({ kind, cause: "git-unavailable" }, `${refused}. ${new GitNotFoundError(process.platform).message}`)
  }
  if (error instanceof RepositoryConfigRefusedError) {
    return answer({ kind, cause: "repository-config" }, `${refused}. ${error.message}`)
  }
  if (error instanceof RepositoryGitConfigUnreadableError) {
    return answer({ kind, cause: "repository-config-unreadable" }, `${refused}. ${error.message}`)
  }
  if (error instanceof GitNotFoundError || error instanceof GitTooOldForIsolationError) {
    return answer({ kind, cause: "git-unavailable" }, `${refused}. ${error.message}`)
  }
  const failure = gitFailureIn(error)
  if (failure === undefined) return answer({ kind, cause: "unknown" }, refused)
  const lockPath = heldLockPattern.exec(failure)?.[1]
  const held = lockPath === undefined || redactInventoryPath(lockPath) !== lockPath || !await inGitDirectories(options.worktree, lockPath)
    ? undefined
    : approvalCheckpointRefusalSchema.safeParse({ kind, cause: "lock-held", lockPath })
  if (held?.success === true && held.data.cause === "lock-held") {
    return answer(
      held.data,
      `Domovoi could not take a checkpoint: ${held.data.lockPath} is held by another git process, or was left by one that stopped, so the command did not run; decide again`,
    )
  }
  return answer({ kind, cause: "git-failed" }, "Domovoi could not take a checkpoint because a Git command failed, so the command did not run; decide again")
}

// Each error in the chain, the error itself first.
function* causes(error: unknown): Generator<Error> {
  let current = error
  for (let depth = 0; depth <= maximumCauseDepth && current instanceof Error; depth += 1) {
    yield current
    current = current.cause
  }
}

// The stderr of the first Git command failure in the error or its causes: a
// failed git run carries what Git printed as `stderr` and its exit status as
// a numeric `code` (execFile's shape, which isolated-checkout.ts keeps).
function gitFailureIn(error: unknown): string | undefined {
  for (const current of causes(error)) {
    const { stderr, code } = current as Error & { stderr?: unknown, code?: unknown }
    if (typeof stderr === "string" && typeof code === "number") return stderr
  }
  return undefined
}

// On POSIX the workspace starts the bare name `git` from PATH, so a missing
// Git is the spawn's ENOENT for that name rather than a GitNotFoundError.
function gitCouldNotStart(error: unknown): boolean {
  for (const current of causes(error)) {
    const { code, syscall } = current as Error & { code?: unknown, syscall?: unknown }
    if (code === "ENOENT" && (syscall === "spawn git" || syscall === "spawn git.exe")) return true
  }
  return false
}

// Whether the lock lies in the worktree's own Git directory or the common
// directory it shares with its repository: where Git keeps the index and
// refs a checkpoint writes. Read from the worktree's .git, as Git reads it;
// anything that cannot be read places the lock nowhere.
async function inGitDirectories(worktree: string, lockPath: string): Promise<boolean> {
  try {
    const marker = resolve(worktree, ".git")
    const gitDirectory = (await lstat(marker)).isDirectory()
      ? marker
      : resolve(worktree, /^gitdir: (.+)$/mu.exec(await readFile(marker, "utf8"))?.[1]?.trim() ?? "")
    const common = await readFile(resolve(gitDirectory, "commondir"), "utf8").then(
      (text) => resolve(gitDirectory, text.trim()),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return gitDirectory
        throw error
      },
    )
    const lockDirectory = await realpath(dirname(lockPath))
    for (const directory of [gitDirectory, common]) {
      const inside = relative(await realpath(directory), lockDirectory)
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return true
    }
    return false
  } catch {
    return false
  }
}
