import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
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
  // the repository's config, which wraps the error.
  const unavailable = gitUnavailableIn(error)
  if (unavailable !== undefined) return answer({ kind, cause: "git-unavailable" }, `${refused}. ${unavailable}`)
  if (error instanceof RepositoryConfigRefusedError) {
    return answer({ kind, cause: "repository-config" }, `${refused}. ${error.message}`)
  }
  if (error instanceof RepositoryGitConfigUnreadableError) {
    return answer({ kind, cause: "repository-config-unreadable" }, `${refused}. ${error.message}`)
  }
  const failure = gitFailureIn(error)
  if (failure === undefined) return answer({ kind, cause: "unknown" }, refused)
  const lockPath = heldLockPattern.exec(failure)?.[1]
  const held = lockPath === undefined || redactInventoryPath(lockPath) !== lockPath || !await lockStandsInGit(options.worktree, lockPath)
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

// Git missing or unusable, anywhere in the chain, as the guidance to show:
// GitNotFoundError (Windows, and isolation everywhere), a Git too old or of
// unknown version, or on POSIX the spawn's ENOENT for the bare name `git`.
function gitUnavailableIn(error: unknown): string | undefined {
  for (const current of causes(error)) {
    if (current instanceof GitNotFoundError || current instanceof GitTooOldForIsolationError) return current.message
    const { code, syscall } = current as Error & { code?: unknown, syscall?: unknown }
    if (code === "ENOENT" && (syscall === "spawn git" || syscall === "spawn git.exe")) return new GitNotFoundError(process.platform).message
  }
  return undefined
}

// How long the daemon looks for the lock before it says only that Git
// failed, and how much of a .git or commondir file it reads.
const lockLookupMs = 2_000
const maximumGitPointerBytes = 4_096

// Whether a lock Git named stands where Git keeps a worktree's locks: it is
// there now, as a file, in the worktree's own Git directory or the common
// directory it shares with its repository. Git's sentence can also come from
// a filter's stderr, so the sentence alone is not enough. Anything that
// cannot be read, or takes too long, places the lock nowhere.
async function lockStandsInGit(worktree: string, lockPath: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<false>((resolveDeadline) => { timer = setTimeout(() => resolveDeadline(false), lockLookupMs) })
  try {
    return await Promise.race([lockInGitDirectories(worktree, lockPath).catch(() => false), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function lockInGitDirectories(worktree: string, lockPath: string): Promise<boolean> {
  if (!(await lstat(lockPath)).isFile()) return false
  const marker = resolve(worktree, ".git")
  const markerStat = await lstat(marker)
  let gitDirectory: string
  if (markerStat.isDirectory()) {
    gitDirectory = marker
  } else {
    const named = /^gitdir: (.+)$/mu.exec(await readGitPointer(marker))?.[1]?.trim()
    if (!named) return false
    gitDirectory = resolve(worktree, named)
  }
  const commondir = resolve(gitDirectory, "commondir")
  const sharesCommon = await lstat(commondir).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false
    throw error
  })
  const named = sharesCommon ? (await readGitPointer(commondir)).trim() : ""
  if (sharesCommon && !named) return false
  const common = sharesCommon ? resolve(gitDirectory, named) : gitDirectory
  const lockDirectory = await realpath(dirname(lockPath))
  for (const directory of [gitDirectory, common]) {
    const inside = relative(await realpath(directory), lockDirectory)
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return true
  }
  return false
}

// A small pointer file Git writes (.git in a linked worktree, commondir):
// opened without blocking, read only if it is a regular file, and bounded.
async function readGitPointer(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    if (!(await handle.stat()).isFile()) throw new Error("A Git pointer is not a regular file")
    const buffer = Buffer.alloc(maximumGitPointerBytes)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}
