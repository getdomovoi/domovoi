import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import { maximumPreviewSourceBytes, type RepositoryGitFilterScope } from "@getdomovoi/protocol"

import { gitCommand } from "./git-command.js"
import {
  gitEnvironment, gitSupportsNoLazyFetch, inertRepositoryConfig, installedGitVersionText, trustedConfigScopes,
} from "./git-environment.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { inventoryFieldCaps, redactInventoryText } from "./inventory-redaction.js"
import {
  carriedRemoteUrl, checkOutIsolated, IndexChangedError, IndexLockHeldError, IndexPublishedNotDurableError, openIsolatedGit, publishUnderIndexLock, readIndexFile, runGitProcess, type IsolatedGit,
} from "./isolated-checkout.js"
import {
  repositoryFilterGate,
  type RepositoryFilterGate,
  type RepositoryFilterRefusalReason,
  type RepositoryFilterTrustLookup,
} from "./repository-git-filter-gate.js"
import { readGitFilterSettings, repositoryGitFilters, type RepositoryGitFilter } from "./repository-git-filters.js"
import { redactDurableText } from "./secret-redaction.js"
import { checkpointPathIsSafe } from "./workspace-redaction.js"
import { RestoreOperationLease, trackRestoreCommand } from "./workspace-restore-lease.js"

const execute = promisify(execFile)
const safeSessionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const safeRemoteName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const commitSha = /^[a-f0-9]{40}$/u
// Reserve synchronously before the first await, across service instances.
// Otherwise a delayed claim opener could acquire after the winner completes
// and turn a concurrent request into an apparently sequential update.
type RestoreClaimReservation = { state: "restoring" | "releasing" | "quarantined" }
const activeBundleRestores = new Map<string, RestoreClaimReservation>()

function checkpointRef(commit: string): string {
  return `refs/domovoi/checkpoints/${commit}`
}

function uniqueCheckpointCommits(commits: readonly string[] = []): string[] {
  if (commits.some((commit) => !commitSha.test(commit))) {
    throw new Error("Transferred checkpoint commit is invalid")
  }
  return [...new Set(commits)]
}

export type RepositoryInfo = {
  root: string
  name: string
  branch: string
  head: string
}

export type SessionWorkspace = {
  path: string
  branch: string
  baseCommit: string
}

export type SessionBranchFacts = {
  branch: string
  unmergedFiles: number
}

export type Checkpoint = {
  commit: string
  changedFiles: string[]
  // snapshot only: true when two consecutive staging passes matched.
  matched?: boolean
  // snapshot only: absent when two consecutive staging passes matched.
  unstablePaths?: string[]
}

export type RestoreResult = {
  restoredCommit: string
  recoveryCommit: string
}

export type SessionCommitRequest = {
  // The session's project checkout; the worktree must be one of its own.
  repositoryPath: string
  sessionId: string
  message: string
  // The session branch's commit the person's view of the changes was read
  // against.
  expectedHead: string
  expectedChangesDigest: string
}

export type SessionCommit = {
  commit: string
  branch: string
  changedFiles: string[]
  // What failed after the branch had moved: the commit stands, and this says
  // what was left undone (the worktree's index, the checkpoint ref).
  afterCommitError?: string
}

type WorktreeCommitOptions = {
  message: string
  // The one branch a person's commit may move and the commit it must still be
  // at, and whether HEAD still names it (read again before the worktree's
  // index is published). A checkpoint moves whatever HEAD names, from where
  // it is.
  branch?: { ref: string; head: string; stillCurrent: () => Promise<boolean> }
  author?: GitIdentity
  // Runs on the staged change set before anything is written; throwing
  // refuses the commit with the worktree, its index and every ref untouched.
  refuse?: (index: string, changedFiles: readonly string[]) => Promise<void>
}

export type SessionCommitRefusal =
  | "not-session-worktree"
  | "not-session-branch"
  | "head-moved"
  | "changes-moved"
  | "nothing-to-commit"
  | "secret-paths"
  | "secret-message"
  | "unreadable-paths"
  | "repository-filters"
  | "held-back-config"

// Repository settings the isolated Git directory may drop for a person's
// commit, because none changes what the commit stores or starts a program
// during it. Everything else the directory holds back refuses the commit
// (refuseHeldBackConfig), a key nothing here names included, so the list only
// ever lets known keys through and fails closed on new ones. Keys are as Git
// lists them: section and variable lowercase, a subsection as written.
// - Repository layout the directory sets for itself: core.repositoryformatversion,
//   core.bare, core.logallrefupdates, extensions.worktreeconfig,
//   extensions.refstorage (it has no refs of its own), lfs.repositoryformatversion.
// - Hooks and fsmonitor, which no daemon Git runs by design: core.hookspath,
//   core.fsmonitor.
// - Index and object storage formats and caches, which change how Git keeps
//   data, not what a tree holds: core.untrackedcache, core.splitindex,
//   core.preloadindex, core.fscache, core.commitgraph, core.multipackindex,
//   index.*, pack.*, gc.*, maintenance.*, feature.*.
// - Programs and settings for other commands, which staging and write-tree
//   never start or read: core.editor, core.pager, core.sshcommand,
//   core.askpass, credential.*, http.*, color.*, alias.*, gui.*, pull.*,
//   push.*, fetch.*, rerere.*, and git-lfs's per-endpoint records below.
// - Where branches and remotes point, which a commit of the index does not
//   read: branch.*, remote.*, submodule.* (every submodule entry is listed and
//   classified with --ignore-submodules=none).
// - The identity, which the commit reads itself and sets explicitly:
//   user.name, user.email, author.*, committer.*.
const commitInertKeys = new Set([
  "core.repositoryformatversion", "core.bare", "core.logallrefupdates", "extensions.worktreeconfig", "extensions.refstorage",
  "lfs.repositoryformatversion", "core.hookspath", "core.fsmonitor", "core.untrackedcache", "core.splitindex",
  "core.preloadindex", "core.fscache", "core.commitgraph", "core.multipackindex", "core.editor", "core.pager",
  "core.sshcommand", "core.askpass", "user.name", "user.email",
])
const commitInertSections = new Set([
  "index", "pack", "gc", "maintenance", "feature", "credential", "http", "color", "alias", "pull", "push", "fetch",
  "rerere", "branch", "remote", "submodule", "author", "committer", "gui",
])

// git-lfs records per endpoint how it authenticates and whether it verifies
// locks (lfs.<url>.access, lfs.<url>.locksverify); a commit's clean step
// computes pointers locally and talks to no endpoint.
const lfsEndpointRecord = /^lfs\..+\.(?:access|locksverify)$/u

function commitInertKey(key: string): boolean {
  return commitInertKeys.has(key) || commitInertSections.has(key.slice(0, key.indexOf("."))) || lfsEndpointRecord.test(key)
}

// Refuses a person's commit while the isolated directory holds back any
// repository setting that is not commit-inert.
function refuseHeldBackConfig(heldBack: readonly string[], branch: string): void {
  const held = heldBack.filter((key) => !commitInertKey(key))
  if (held.length > 0) throw new SessionCommitRefusedError("held-back-config", branch, held.length, held)
}

// Why Domovoi did not commit. Every refusal leaves the worktree, its index and
// every ref as they were. A secret file is counted, never named: the thread
// and the person's screen never show a secret path (#541).
export class SessionCommitRefusedError extends Error {
  readonly reason: SessionCommitRefusal

  constructor(reason: SessionCommitRefusal, branch = "its session branch", count = 0, keys: readonly string[] = []) {
    super(sessionCommitRefusalText(reason, branch, count, keys))
    this.name = "SessionCommitRefusedError"
    this.reason = reason
  }
}

function sessionCommitRefusalText(reason: SessionCommitRefusal, branch: string, count: number, keys: readonly string[]): string {
  switch (reason) {
    case "not-session-worktree":
      return "Domovoi commits only in a session's own worktree, and this session's worktree is not one Domovoi made for it. Nothing was committed."
    case "not-session-branch":
      return `The worktree is not on ${branch}, so Domovoi did not commit. Domovoi commits on the session branch and never on another.`
    case "head-moved":
      return `${branch} moved since these changes were read. Nothing was committed. Read the changes again, then commit.`
    case "changes-moved":
      return "The changes no longer match the reviewed change set. Nothing was committed. Refresh and review the changes again, then commit."
    case "nothing-to-commit":
      return `The worktree matches ${branch}, so there is nothing to commit.`
    case "secret-paths":
      return `${count} ${count === 1 ? "file" : "files"} in these changes ${count === 1 ? "looks" : "look"} like a credential, a private key or an environment file. Domovoi does not commit such files, so nothing was committed. Remove ${count === 1 ? "it" : "them"} or add ${count === 1 ? "it" : "them"} to .gitignore, then commit again.`
    case "secret-message":
      return "The commit message looks like it holds a secret, and a message stays in the branch's history. Nothing was committed. Take the secret out of the message, then commit."
    case "unreadable-paths":
      return "Git named a changed path Domovoi cannot read as UTF-8, so it could not check every file. Nothing was committed."
    case "repository-filters":
      return "This repository's own Git config sets a filter, and staging would run it. Domovoi runs no program a repository names when it commits, and committing without the filter would commit what it exists to change, so nothing was committed. Commit in your own checkout."
    case "held-back-config": {
      // Key names only, redacted as any repository config text is; values never.
      const shown = keys.slice(0, 3).map((key) => redactInventoryText(key, inventoryFieldCaps.detail)).join(", ")
      const more = count > 3 ? ` and ${count - 3} more` : ""
      return `This repository's own Git config sets ${shown}${more}, which Domovoi's isolated Git does not read as Git would, so the commit could store something other than Git would. Nothing was committed. Commit in your own checkout, or take the setting out and commit again.`
    }
  }
}

export type FileRevert = {
  path: string
  outcome: "restored" | "removed"
  baseCommit: string
  recoveryCommit: string
}

export type ChangedFileEvidence = {
  path: string
  previousPath?: string
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted"
  staged: boolean
  unstaged: boolean
  additions: number | null
  deletions: number | null
  binary: boolean
}

export type WorkspaceEvidence = {
  // Absent when the file view is readable but safe staging is unavailable.
  changesDigest?: string
  baseCommit: string
  diff: string
  diffTruncated: boolean
  totalChangedFiles: number
  files: ChangedFileEvidence[]
  filesTruncated: boolean
  // Internal observations projected into session.evidence.fileAssociations.
  // Absence means the service did not observe a target, not that paths are new.
  revertTargets?: Array<{ path: string; kind: "restore" | "remove" }>
}

export const maximumEvidenceFiles = 200
export const maximumEvidenceDiffBytes = 256 * 1_024
const maximumEvidenceAttempts = 3
// Evidence is interactive. Larger staging inputs remain visible but cannot
// authorize Commit. This bounds compression work before Git opens an index
// lock; the deadline below also covers slow storage and clean filters.
const maximumEvidenceStagingBytes = 64 * 1_024 * 1_024
const evidenceStagingBudgetMs = 5_000
const maximumGitOutputBytes = 32 * 1_024 * 1_024
const restoreClaimIoTimeoutMs = 10_000

export class SessionWorktreeExistsError extends Error {
  constructor(restoreClaimPath?: string) {
    super(restoreClaimPath === undefined
      ? "Session worktree already exists"
      : `Session worktree already exists or its restore claim is held at ${restoreClaimPath}. Stop Domovoi and its supervisor before removing a confirmed stale claim.`)
    this.name = "SessionWorktreeExistsError"
  }
}

export class SessionRestoreClaimQuarantinedError extends Error {
  constructor(readonly claimPath: string) {
    super(`Restore claim cleanup is still pending at ${claimPath}. Wait for cleanup to settle, or stop every Domovoi process and its supervisor before inspecting and removing a confirmed stale claim.`)
    this.name = "SessionRestoreClaimQuarantinedError"
  }
}

class RestoreClaimReleaseDeadlineError extends Error {
  constructor(phase: string) {
    super(`Restore claim ${phase} exceeded the ${restoreClaimIoTimeoutMs} ms release deadline. Pending I/O remains quarantined until it settles. Stop every Domovoi process and its supervisor before removing a confirmed stale claim.`)
    this.name = "RestoreClaimReleaseDeadlineError"
  }
}

class RestoreClaimOwnerVerificationError extends Error {
  constructor(tokenWritten: boolean) {
    super(tokenWritten
      ? "Restore claim now belongs to another owner"
      : "Restore claim owner could not be established")
    this.name = "RestoreClaimOwnerVerificationError"
  }
}

export class SessionRestoreClaimCleanupError extends AggregateError {
  readonly restoreCompleted: boolean

  constructor(
    readonly claimPath: string,
    cleanupErrors: readonly unknown[],
    restoreFailure?: { error: unknown },
  ) {
    const ownershipError = cleanupErrors.find((error) => error instanceof RestoreClaimOwnerVerificationError)
    const deadlineError = cleanupErrors.find((error) => error instanceof RestoreClaimReleaseDeadlineError)
    const diagnostic = `Restore claim cleanup failed at ${claimPath}${ownershipError ? `. ${ownershipError.message}` : ""}${deadlineError ? `. ${deadlineError.message}` : ""}`
    super(
      restoreFailure ? [restoreFailure.error, ...cleanupErrors] : cleanupErrors,
      restoreFailure
        ? `${restoreFailure.error instanceof Error ? restoreFailure.error.message : "Session restore failed"}. ${diagnostic}`
        : `Session restore completed. ${diagnostic}. Do not retry the completed restore; inspect the named claim file.`,
      { cause: restoreFailure ? restoreFailure.error : cleanupErrors[0] },
    )
    this.name = "SessionRestoreClaimCleanupError"
    this.restoreCompleted = restoreFailure === undefined
  }
}

async function releaseRestoreClaim(
  claim: Awaited<ReturnType<typeof open>>,
  claimPath: string,
  claimToken: string,
  claimTokenWritten: boolean,
  reservation: RestoreClaimReservation,
  lease: RestoreOperationLease,
): Promise<unknown[]> {
  const errors: unknown[] = []
  // Release gets one fresh budget even when the restore was cancelled. A
  // timeout bounds the caller's wait, not an uncancellable close or unlink.
  const deadline = OperationDeadline.start(restoreClaimIoTimeoutMs)
  reservation.state = "releasing"
  let phase = "close"
  const releasing = (async () => {
    try {
      // An immediate close failure must still allow ownership-checked unlink.
      try { await claim.close() } catch (error) { errors.push(error) }
      deadline.throwIfExpired()
      phase = "ownership read"
      const currentToken = await readFile(claimPath, { encoding: "utf8", signal: deadline.signal })
      deadline.throwIfExpired()
      if (currentToken !== claimToken) throw new RestoreClaimOwnerVerificationError(claimTokenWritten)
      lease.assertRecordedSettlement()
      phase = "unlink"
      // Path verification and unlink are not atomic. Manual removal requires
      // stopped daemons, including when the release deadline has expired.
      await unlink(claimPath)
    } finally {
      // Only actual settlement releases exclusion. In particular, a pending
      // unlink must never overlap a successor, even if the path is absent.
      if (activeBundleRestores.get(claimPath) === reservation) activeBundleRestores.delete(claimPath)
      lease.release()
    }
  })()
  try {
    await beforeDeadline(releasing, deadline)
  } catch (error) {
    if (deadline.signal.aborted) {
      if (activeBundleRestores.get(claimPath) === reservation) reservation.state = "quarantined"
      errors.push(new RestoreClaimReleaseDeadlineError(phase))
    } else {
      errors.push(error)
    }
  } finally {
    deadline.clear()
  }
  return errors
}

export class FileRevertTargetChangedError extends Error {
  constructor() {
    super("Revert target changed; refresh file evidence before confirming again")
    this.name = "FileRevertTargetChangedError"
  }
}

// The recovery checkpoint is taken before the worktree moves, so a revert that
// stops afterwards still has somewhere to put the work back. The commit travels
// with the failure rather than being lost with it.
export class FileRevertIncompleteError extends Error {
  readonly recoveryCommit: string
  constructor(recoveryCommit: string, options?: { cause?: unknown }) {
    super(
      `File revert stopped after its recovery checkpoint ${recoveryCommit.slice(0, 8)}`,
      options,
    )
    this.name = "FileRevertIncompleteError"
    this.recoveryCommit = recoveryCommit
  }
}

// Refused because a command or URL the repository's own config supplies would
// run or apply. The message names the setting and where it is set.
export class RepositoryConfigRefusedError extends Error {}

// A checkpoint records a submodule by the commit it is at, not by its files,
// so a submodule's local changes would be left out of it. Ruled 2026-09-23:
// such a snapshot is refused rather than taken without them.
export class SubmoduleChangesRefusedError extends Error {
  constructor() {
    super("A submodule has local changes a checkpoint cannot hold")
    this.name = "SubmoduleChangesRefusedError"
  }
}

const maximumSubmoduleDepth = 8

// For a status or diff of the superproject: a submodule's commit is compared,
// but Git does not look into its worktree, which would run a `git status`
// there under the submodule's own config. Local work inside a submodule is
// found by submoduleHasLocalChanges instead.
const outsideSubmodules = "--ignore-submodules=dirty"

// The checked-out submodules directly in a worktree, from its index: a
// gitlink whose path holds a .git. One that is not checked out holds no
// local work and no config Git would read there.
async function checkedOutSubmodules(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
  const listed = await rawGit(worktreePath, ["ls-files", "--stage", "-z"], signal)
  const submodules: string[] = []
  for (const record of listed.split("\0")) {
    if (!record.startsWith("160000 ")) continue
    const submodule = resolve(worktreePath, record.slice(record.indexOf("\t") + 1))
    if (!pathStaysInside(worktreePath, submodule)) throw new Error("Git named a submodule outside the worktree")
    if (submodules.includes(submodule)) continue
    if (await lstat(join(submodule, ".git")).then(() => true, () => false)) submodules.push(submodule)
  }
  return submodules
}

// A checked-out submodule whose own Git config sets a filter. Staging the
// superproject looks into every checked-out submodule with a `git status`
// that reads that submodule's config, and no trust grant reviews a
// submodule's filters, so the operation is refused and nothing runs.
// A submodule as a refusal names it: by its path, unless the path names a
// credential, a private key or an environment file, which is never shown.
function submoduleShown(submodule: string): string {
  return checkpointPathIsSafe(submodule)
    ? `The submodule "${redactInventoryText(submodule, inventoryFieldCaps.detail)}"`
    : "A submodule whose path Domovoi does not show"
}

export class SubmoduleFilterRefusedError extends RepositoryConfigRefusedError {
  constructor(submodule: string, filters: readonly RepositoryGitFilter[]) {
    super(
      `${submoduleShown(submodule)} sets the filter `
      + `${filterNames(filters).map((name) => `"${shownName(name)}"`).join(", ")} in its own Git config (${shownSettings(filters)}). `
      + "Checkpoint, restore, revert and transfer would run it, and no trust covers a submodule's own filters, "
      + "so Domovoi does not run it. Nothing ran.",
    )
    this.name = "SubmoduleFilterRefusedError"
  }
}

// A checked-out submodule that is a partial clone by its own Git config. The
// `git status` staging runs in it could fetch a missing object through the
// promisor remote that config names, with that config's own transport
// settings, which no trust covers.
export class SubmodulePromisorRefusedError extends RepositoryConfigRefusedError {
  constructor(submodule: string) {
    super(
      `${submoduleShown(submodule)} is a partial clone with a promisor remote `
      + "in its own Git config. Reading it could fetch a missing object through that remote with the submodule's own "
      + "transport settings, which no trust covers, so Domovoi does not read it. Nothing ran.",
    )
    this.name = "SubmodulePromisorRefusedError"
  }
}

const promisorSettingPattern = String.raw`^(extensions\.partialclone|remote\..+\.promisor)$`

// A partial clone on a Git that cannot be kept from lazy fetching (before
// 2.45, or a version that cannot be read): a missing object would be fetched
// through the promisor remote the repository's own config names, with that
// config's transport settings. Refused before anything reads an object.
export class GitLazyFetchUnsupportedError extends RepositoryConfigRefusedError {
  constructor(version: string | undefined) {
    super(
      `This repository is a partial clone, and the installed Git (${version === undefined ? "version unknown" : redactInventoryText(version, inventoryFieldCaps.detail)}) `
      + "cannot be told not to fetch a missing object through the repository's own promisor remote. Domovoi needs Git 2.45 "
      + "or later to work in a partial clone. Nothing ran.",
    )
    this.name = "GitLazyFetchUnsupportedError"
  }
}

// Whether a repository's config makes it a partial clone: an
// extensions.partialClone, or a remote marked promisor. Reading the config
// runs nothing.
async function hasPromisor(repositoryPath: string, signal?: AbortSignal): Promise<boolean> {
  let output: string
  try {
    output = await rawGit(repositoryPath, ["config", "-z", "--get-regexp", promisorSettingPattern], signal)
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false
    throw error
  }
  return output.split("\0").filter((record) => record !== "").some((record) => {
    const newline = record.indexOf("\n")
    const key = newline === -1 ? record : record.slice(0, newline)
    const value = newline === -1 ? "true" : record.slice(newline + 1)
    return key.startsWith("extensions.") ? value !== "" : !/^(false|no|off|0)$/iu.test(value)
  })
}

// Refuses while any checked-out submodule, at any depth, sets a filter in
// its own Git config, or is a partial clone by it: staging the superproject
// runs a `git status` in each, under that config. Reading the config runs
// nothing. A submodule whose config cannot be read fails the caller.
async function refuseSubmoduleConfig(top: string, worktreePath: string = top, signal?: AbortSignal, depth = 0): Promise<void> {
  for (const submodule of await checkedOutSubmodules(worktreePath, signal)) {
    if (depth >= maximumSubmoduleDepth) throw new Error("Submodules nest deeper than Domovoi reads")
    const shown = relative(top, submodule).split(sep).join("/")
    const filters = repositoryGitFilters(await readGitFilterSettings(submodule, signal))
    if (filters.length > 0) throw new SubmoduleFilterRefusedError(shown, filters)
    if (await hasPromisor(submodule, signal)) throw new SubmodulePromisorRefusedError(shown)
    await refuseSubmoduleConfig(top, submodule, signal, depth + 1)
  }
}

// A submodule's HEAD commit, read offline (gitEnvironment): undefined while
// its branch is unborn. A HEAD that names a commit the submodule does not
// have fails the caller rather than being fetched.
async function submoduleHead(submodule: string, signal?: AbortSignal): Promise<string | undefined> {
  const named = await git(submodule, ["rev-parse", "-q", "--verify", "HEAD"], signal).catch(() => "")
  if (named === "") return undefined
  try {
    await git(submodule, ["cat-file", "-e", `${named}^{commit}`], signal)
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error("A submodule's HEAD names a commit it does not have", { cause: error })
  }
  return named
}

// Whether any checked-out submodule, at any depth, has changed tracked
// content, a changed nested submodule commit, or untracked files: local work
// a checkpoint, which records a submodule by its commit, cannot hold.
//
// A recursive `git status` would read each submodule's own config and run
// what it names (a filter, core.fsmonitor), which no trust grant reviews. So
// the submodules are found from the index, and each is read through an
// isolated Git directory of its own (isolated-checkout.ts) that reads none of
// its config, with status kept out of its own submodules, which this walk
// reads in turn. A submodule that cannot be read fails the caller.
async function submoduleHasLocalChanges(worktreePath: string, signal?: AbortSignal, depth = 0): Promise<boolean> {
  for (const submodule of await checkedOutSubmodules(worktreePath, signal)) {
    if (depth >= maximumSubmoduleDepth) throw new Error("Submodules nest deeper than Domovoi reads")
    if (await submoduleWorktreeChanged(submodule, signal)) return true
    if (await submoduleHasLocalChanges(submodule, signal, depth + 1)) return true
  }
  return false
}

async function submoduleWorktreeChanged(submodule: string, signal?: AbortSignal): Promise<boolean> {
  const isolated = await openIsolatedGit({ worktree: submodule, worktreeIndex: true, signal })
  try {
    const head = await submoduleHead(submodule, signal)
    if (head !== undefined) await isolated.setHead(head)
    // No optional locks: status must not refresh the index the agent shares.
    const status = await isolated.run([
      "--no-optional-locks", "status", "--porcelain=v2", "-z", "--ignore-submodules=dirty", "--untracked-files=normal",
    ], { signal })
    return status.split("\0").some((record) => record !== "")
  } finally {
    await isolated.dispose()
  }
}

// A config key or driver name is the repository's own text and can hold a
// credential ([filter "api_token=..."], a URL with its user info). A refusal's
// message reaches clients, so each is shown as the tool inventory shows text:
// redacted, and fitted to the cap of its kind of field.
const shownName = (name: string) => redactInventoryText(name, inventoryFieldCaps.name)
const shownSettings = (entries: readonly { scope: string; key: string }[]) =>
  entries.map(({ scope, key }) => `${redactInventoryText(key, inventoryFieldCaps.detail)} in ${scope} Git config`).join(", ")

// Why the filters stay held back, by the gate's reason
// (repository-git-filter-gate.ts). The trust sheet's own copy comes with the
// client (P11b); this is the daemon's plain account.
const heldBackText: Readonly<Record<RepositoryFilterRefusalReason, string>> = {
  "not-trusted": "Domovoi runs a filter a repository's own Git config sets only once that repository is trusted on this machine.",
  "config-changed": "The repository's configuration is not the one trusted on this machine, so Domovoi holds its filters back until it is reviewed again.",
  "cannot-trust": "The repository holds configuration Domovoi cannot trust, so its filters stay held back.",
  unreadable: "Domovoi could not read the repository's configuration to check its trust, so its filters stay held back.",
  "filters-not-reviewed": "The repository is trusted on this machine, but its Git filters were not shown when it was trusted, so they stay "
    + "held back. Review the repository and trust it again from an updated Domovoi client to let them run.",
  "filters-changed": "The repository is trusted on this machine, but its Git filters as Domovoi lists them now are not the ones shown when "
    + "it was trusted, so they stay held back. Review the repository and trust it again to let them run.",
}

const driversOf = (filters: readonly RepositoryGitFilter[]) => {
  const seen = new Set<string>()
  return filters.flatMap(({ driver, scope }) => {
    const id = `${scope}\0${driver}`
    if (seen.has(id)) return []
    seen.add(id)
    return [{ name: driver, scope }]
  })
}

const filterNames = (filters: readonly RepositoryGitFilter[]) => [...new Set(filters.map(({ driver }) => driver))]

// A checkpoint, snapshot, restore, revert or transfer of a session worktree
// refused: Git would run a filter the repository's own config sets, and the
// repository's trust on this machine does not cover it (or a new session's
// worktree, in RepositoryGitFilterRefusedError below). Nothing ran. drivers
// names each driver once per scope; settings are the filters as the refused
// command's worktree read them, commands included, for the refusal's digest,
// never sent, stored or logged. projectId names the project the gate looked
// trust up for, when the path belonged to one.
export class RepositoryFilterRefusedError extends RepositoryConfigRefusedError {
  readonly filters: readonly string[]
  readonly drivers: readonly { name: string; scope: RepositoryGitFilterScope }[]
  readonly settings: readonly RepositoryGitFilter[]
  readonly reason: RepositoryFilterRefusalReason
  readonly projectId: string | undefined

  constructor(filters: readonly RepositoryGitFilter[], options: { reason?: RepositoryFilterRefusalReason; projectId?: string | undefined } = {}) {
    const reason = options.reason ?? "not-trusted"
    super(
      `This repository's own Git config sets the filter ${filterNames(filters).map((name) => `"${shownName(name)}"`).join(", ")} (${shownSettings(filters)}). `
      + `Checkpoint, restore, revert and transfer would run its command. ${heldBackText[reason]} Nothing ran. `
      + "Filters from your global or system Git config still run.",
    )
    this.name = "RepositoryFilterRefusedError"
    this.filters = filterNames(filters)
    this.drivers = driversOf(filters)
    this.settings = filters
    this.reason = reason
    this.projectId = options.projectId
  }
}

// A new session worktree (session.create, session.fork or a transfer arriving)
// was not checked out: Git, reading config as that worktree reads it, would
// run a filter the repository's own config sets.
//
// The cleanup state, each part as it was reached: worktreeRemoved, the new
// worktree is gone (true when none was made); false when taking it away
// failed, so the caller keeps its record of the attempt. branchRemoved, the
// branch this operation made is deleted; false when deleting it failed and it
// remains; undefined when there was none to delete or the worktree stayed, so
// deleting it was not tried.
export type NewWorktreeCleanup = { worktreeRemoved: boolean; branchRemoved: boolean | undefined }

function cleanupText(cleanup: NewWorktreeCleanup): string {
  if (!cleanup.worktreeRemoved) {
    return "Domovoi could not take the new worktree away: it stays unchecked-out where it was added, with its "
      + "branch, and the record of this session's creation is kept for recovery. "
  }
  if (cleanup.branchRemoved === false) return "The new worktree was taken away, but its branch could not be deleted and remains. "
  return "No worktree was left. "
}

// A new session worktree whose checkout was stopped part way, by a cancel or
// a timeout. Its process group was killed, but a process a filter started
// can have left the group, so Domovoi cannot confirm that nothing still
// writes to the worktree, and does not delete it: the worktree stays where it
// was added, with its branch, and the record of the session's creation is
// kept for recovery.
export class NewWorktreeKeptError extends Error {
  constructor(cause: unknown, why = "a process the stopped checkout started may still be running") {
    super(
      `${cause instanceof Error ? cause.message : "The checkout stopped"}. The new worktree was partly checked out and stays `
      + `where it was added, with its branch, kept for recovery: ${why}.`,
      { cause },
    )
    this.name = "NewWorktreeKeptError"
  }
}

export class RepositoryGitFilterRefusedError extends RepositoryFilterRefusedError {
  readonly worktreeRemoved: boolean
  readonly branchRemoved: boolean | undefined

  constructor(
    filters: readonly RepositoryGitFilter[],
    cleanup: NewWorktreeCleanup,
    options: { reason?: RepositoryFilterRefusalReason; projectId?: string | undefined } = {},
  ) {
    super(filters, options)
    this.message = `This repository's own Git config sets the filter ${filterNames(filters).map((name) => `"${shownName(name)}"`).join(", ")} (${shownSettings(filters)}). `
      + `Checking it out for this session would run its command. ${heldBackText[this.reason]} Nothing ran. `
      + cleanupText(cleanup)
      + "Filters from your global or system Git config still run."
    this.worktreeRemoved = cleanup.worktreeRemoved
    this.branchRemoved = cleanup.branchRemoved
    this.name = "RepositoryGitFilterRefusedError"
  }
}

export class RepositoryTransportRefusedError extends RepositoryConfigRefusedError {
  constructor(entries: readonly { scope: string; key: string }[]) {
    super(
      `This repository's own Git config sets ${shownSettings(entries)}. `
      + "Push and fetch would follow it, and Domovoi does not apply commands or URL rewrites a repository's "
      + "own config supplies until that repository can be trusted. Settings from your global or system Git config still apply.",
    )
    this.name = "RepositoryTransportRefusedError"
  }
}

async function configEntries(
  repositoryPath: string,
  pattern: string,
  signal?: AbortSignal,
): Promise<{ scope: string; key: string; value: string }[]> {
  let output: string
  try {
    output = await git(repositoryPath, ["config", "--show-scope", "-z", "--get-regexp", pattern], signal)
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return []
    throw error
  }
  const fields = output.split("\0")
  const entries: { scope: string; key: string; value: string }[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const record = fields[index + 1]!
    const newline = record.indexOf("\n")
    entries.push({
      scope: fields[index]!,
      key: newline === -1 ? record : record.slice(0, newline),
      value: newline === -1 ? "" : record.slice(newline + 1),
    })
  }
  return entries
}

const remoteProtocols = ["https", "http", "ssh", "git"] as const

// Whether a session transfer pushes to or fetches from this repository
// remote address: the forms a checkout carries (carriedRemoteUrl: https,
// http, ssh, git or an scp-like address). A local path or a file:// URL is
// refused: Git would run the receiving or serving side on this machine, with
// that repository's own hooks and config, which the repository chose. So is
// a `<helper>::` address, any other scheme, a control character or a host
// starting with "-".
export function transferRemoteUrl(url: string): boolean {
  return carriedRemoteUrl(url)
}

export class RepositoryRemoteRefusedError extends RepositoryConfigRefusedError {
  constructor(remote: string) {
    super(
      `The remote "${shownName(remote)}" has an address or a remote helper Domovoi does not push to or fetch from. `
      + "A session transfer uses https, http, ssh and git remotes only, not a local path or a file:// URL.",
    )
    this.name = "RepositoryRemoteRefusedError"
  }
}

// Refuses a remote whose effective fetch or push address a transfer does not
// use, or which names a remote helper through its vcs setting. The addresses
// are read as Git resolves them, URL rewrites included.
async function refuseRemoteAddresses(repositoryPath: string, remote: string, signal?: AbortSignal): Promise<void> {
  const addresses = [
    ...(await git(repositoryPath, ["remote", "get-url", "--all", "--", remote], signal)).split("\n"),
    ...(await git(repositoryPath, ["remote", "get-url", "--push", "--all", "--", remote], signal)).split("\n"),
  ]
  const vcs = await git(repositoryPath, ["config", "--get-all", `remote.${remote}.vcs`], signal).catch((error: { code?: unknown }) => {
    if (error.code === 1) return ""
    throw error
  })
  if (vcs !== "" || addresses.some((address) => !transferRemoteUrl(address))) throw new RepositoryRemoteRefusedError(remote)
}

// Push and fetch run the commands these settings name, or send the repository
// somewhere else. The repository's own values are replaced by the person's
// (global or system) or by Git's defaults; a URL rewrite or proxy command it
// sets is refused, since no override can remove one.
const transportSettingPattern = String.raw`^(core\.(sshcommand|askpass|gitproxy)|credential\..*helper|remote\..*\.(uploadpack|receivepack)|url\..*\.(insteadof|pushinsteadof))$`

// `source` says where the transfer reads or writes: a named repository
// remote, or a bundle file Domovoi itself wrote and names by path.
async function repositoryTransportOverrides(
  repositoryPath: string,
  source: "remote" | "bundle",
  signal?: AbortSignal,
): Promise<string[]> {
  const entries = await configEntries(repositoryPath, transportSettingPattern, signal)
  const untrusted = entries.filter(({ scope }) => !trustedConfigScopes.has(scope))
  const refused = untrusted.filter(({ key }) => key.includes("=") || /^(core\.gitproxy|url\..*\.(insteadof|pushinsteadof))$/u.test(key))
  if (refused.length > 0) throw new RepositoryTransportRefusedError(refused)
  // Only the transports a session transfer uses: https, http, ssh and git
  // for a repository remote, and file only for a bundle path Domovoi
  // supplies. Every other transport, ext:: and any `<helper>::` address or
  // remote vcs setting that would start git-remote-<helper>, is refused by
  // Git. A bundle fetch reads the file and starts no serving side.
  const protocols = source === "bundle" ? ["file"] : remoteProtocols
  const overrides = [
    "-c", "protocol.allow=never",
    ...protocols.flatMap((protocol) => ["-c", `protocol.${protocol}.allow=always`]),
    "-c", "push.gpgSign=false",
  ]
  for (const key of new Set(untrusted.map(({ key }) => key))) {
    const trusted = entries
      .filter((entry) => entry.key === key && trustedConfigScopes.has(entry.scope))
      .map(({ value }) => value)
    if (/^credential\..*helper$/u.test(key)) {
      overrides.push("-c", `${key}=`, ...trusted.flatMap((value) => ["-c", `${key}=${value}`]))
      continue
    }
    const fallback = key === "core.sshcommand"
      ? "ssh"
      : key.endsWith(".uploadpack")
        ? "git-upload-pack"
        : key.endsWith(".receivepack") ? "git-receive-pack" : ""
    overrides.push("-c", `${key}=${trusted.at(-1) ?? fallback}`)
  }
  return overrides
}

// Takes away the new worktree, then the branch this operation made, and says
// which of the two it reached. It takes no signal: a cancelled operation still
// takes away what it made. `worktree remove --force` skips the clean check,
// so it runs no filter. A worktree that stays keeps its branch checked out,
// so deleting the branch is not tried.
async function discardNewWorktree(repositoryPath: string, path: string, madeBranch: string | undefined): Promise<NewWorktreeCleanup> {
  try {
    await git(repositoryPath, ["worktree", "remove", "--force", path])
  } catch {
    return { worktreeRemoved: false, branchRemoved: undefined }
  }
  if (madeBranch === undefined) return { worktreeRemoved: true, branchRemoved: undefined }
  try {
    await git(repositoryPath, ["branch", "-D", madeBranch])
    return { worktreeRemoved: true, branchRemoved: true }
  } catch {
    return { worktreeRemoved: true, branchRemoved: false }
  }
}

// Records the work in the index as a commit on HEAD. Any Git command that
// writes the index can run a clean filter: it compares a racily clean file's
// contents before writing. So the tree is written through the isolated
// directory, and the commit and the branch with plumbing that reads no index
// (`git commit` also refreshes the index first). Hooks are inert and nothing
// is signed, as for every daemon commit. `ref` is the one ref that moves:
// HEAD for a checkpoint, the session branch itself for a person's commit, so
// a HEAD switched meanwhile cannot carry that commit onto another branch.
// `author` is the person a commit is made for; Domovoi is always the
// committer, and the author too when no person is named.
async function commitIndex(
  worktreePath: string,
  isolated: IsolatedGit,
  parent: string | undefined,
  message: string,
  signal: AbortSignal | undefined,
  index: string,
  ref = "HEAD",
  author?: GitIdentity,
): Promise<string> {
  const tree = (await isolated.run(["write-tree"], { index, signal })).trim()
  const commit = await git(worktreePath, [
    "-c", "user.name=Domovoi", "-c", "user.email=domovoi@localhost", "-c", "commit.gpgsign=false",
    "commit-tree", "--no-gpg-sign", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", message,
  ], signal, author === undefined ? {} : {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: "Domovoi",
    GIT_COMMITTER_EMAIL: "domovoi@localhost",
  })
  // An empty old value requires that the branch does not exist yet.
  if (ref === "HEAD") {
    await git(worktreePath, ["update-ref", "-m", `commit: ${message}`, ref, commit, parent ?? ""], signal)
    return commit
  }
  // A named branch moves itself, never a ref it might point at (--no-deref),
  // and only from parent. Once started the update runs to its end, so an
  // abort cannot leave a moved branch the caller believes unmoved.
  signal?.throwIfAborted()
  await git(worktreePath, ["update-ref", "--no-deref", "-m", `commit: ${message}`, ref, commit, parent ?? ""])
  return commit
}

type GitIdentity = { name: string; email: string }

// The person's name and email as Git reads them for this worktree, when both
// are set. Reading a value runs nothing: hooks are inert and fsmonitor is off.
// Otherwise Domovoi is the author.
async function personIdentity(worktreePath: string, signal?: AbortSignal): Promise<GitIdentity> {
  const value = (key: string) => git(worktreePath, ["config", "--get", key], signal).catch(() => "")
  const [name, email] = await Promise.all([value("user.name"), value("user.email")])
  return name && email ? { name, email } : { name: "Domovoi", email: "domovoi@localhost" }
}

// What `git reset --hard` clears of an operation in progress, which a reset
// run in an isolated Git directory clears only there (Git's branch.c
// remove_branch_state, observed with Git 2.54): the merge state, the squash
// message, the cherry-pick and revert heads, and, after a pick head, a
// sequencer whose last pick is done. Pseudorefs are deleted through Git, so a
// reftable repository loses them too; the files are removed by path in the
// worktree's own Git directory. Anything that cannot be removed fails the
// caller. A merge autostash is left as it is: storing it is a stash
// operation, and the file holds data, not a program.
async function clearOperationState(worktreePath: string, signal?: AbortSignal): Promise<void> {
  const files = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR", "AUTO_MERGE", "SQUASH_MSG", "sequencer/todo", "sequencer"]
  const paths = (await git(worktreePath, ["rev-parse", ...files.flatMap((name) => ["--git-path", name])], signal))
    .split("\n").map((line) => resolve(worktreePath, line.trim()))
  const pathOf = (name: string) => paths[files.indexOf(name)]!
  let pickHead = false
  for (const ref of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE"]) {
    const present = await git(worktreePath, ["rev-parse", "-q", "--verify", ref], signal).then(() => true, () => false)
    if (!present) continue
    if (ref !== "AUTO_MERGE") pickHead = true
    await git(worktreePath, ["update-ref", "--no-deref", "-d", ref], signal)
  }
  for (const name of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR", "AUTO_MERGE", "SQUASH_MSG"]) {
    await unlink(pathOf(name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  if (!pickHead) return
  // Git removes the sequencer once its todo holds one line or none.
  const todo = await readFile(pathOf("sequencer/todo"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (todo === undefined) return
  const newline = todo.indexOf("\n")
  if (newline === -1 || newline === todo.length - 1) await rm(pathOf("sequencer"), { recursive: true, force: true })
}

export class WorkspaceEvidenceUnstableError extends Error {
  constructor() {
    super("Workspace changed while evidence was collected")
    this.name = "WorkspaceEvidenceUnstableError"
  }
}

export type GitWorkspaceServiceOptions = {
  // Interactive staging allowance; configurable for deadline tests.
  evidenceStagingBudgetMs?: number
  afterEvidenceObservation?: (observation: "status") => void | Promise<void>
  afterCheckpointStaging?: () => void | Promise<void>
  afterIgnoredArtifactValidation?: () => void | Promise<void>
  // Runs once a new session worktree's config has been read, before it is
  // checked out or taken away: a test seam for what can happen in between.
  afterNewWorktreeScan?: (worktreePath: string) => void | Promise<void>
  // Runs once the filter gate of an operation on an existing session
  // worktree has decided, before the commands it guards: a test seam too.
  afterRepositoryFilterGate?: (worktreePath: string) => void | Promise<void>
  // Runs once a restore's isolated reset has written the checkpoint into the
  // files and the index, before the branch moves: a test seam.
  afterRestoreReset?: () => void | Promise<void>
  // Runs once a person's commit has moved the session branch, before the
  // worktree's index is published: a test seam.
  afterSessionCommit?: (worktreePath: string) => void | Promise<void>
  // The project a gated path belongs to, with this machine's grant for it,
  // read at every call (repository-git-filter-gate.ts). Without it, every
  // repository filter stays held back.
  repositoryTrust?: RepositoryFilterTrustLookup
  // `git --version` as the daemon's Git prints it, for the lazy-fetch check
  // (refuseLazyFetch). The installed Git's by default; a test seam.
  gitVersion?: () => Promise<string | undefined>
  // The deadline of each session ref push; sessionRefTransferTimeoutMs by
  // default. A test seam.
  sessionRefTransferTimeoutMs?: number
}

// A session ref push talks to a remote that may never answer: Git for Windows
// was seen to hang on a push to git daemon's receive-pack (ruling Q265). Each
// push is stopped after this long, whether or not the caller gave a signal.
// Ten minutes leaves room for a large first push over a slow link.
export const sessionRefTransferTimeoutMs = 10 * 60 * 1000

// On a Git that ignores GIT_NO_LAZY_FETCH, refuses a repository or worktree
// that is a partial clone by its own effective config, before any command
// that reads an object runs there. Other repositories cannot lazy fetch and
// work as before. Reading the version and the config reads no object.
async function refuseLazyFetch(path: string, version: () => Promise<string | undefined>, signal?: AbortSignal): Promise<void> {
  const text = await version()
  if (gitSupportsNoLazyFetch(text)) return
  if (await hasPromisor(path, signal)) throw new GitLazyFetchUnsupportedError(text)
}

export interface WorkspaceService {
  inspect(repositoryPath: string, signal?: AbortSignal): Promise<RepositoryInfo>
  sessionWorkspacePath?(sessionId: string): string
  validateCreatedSessionWorkspace?(
    repositoryPath: string,
    sessionId: string,
    workspace: SessionWorkspace,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace>
  createSessionWorkspace(
    repositoryPath: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace>
  createSessionWorkspaceFromCheckpoint?(
    sourceWorktreePath: string,
    checkpointCommit: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace>
  removeSessionWorkspace(worktreePath: string, signal?: AbortSignal): Promise<void>
  archiveSessionWorkspace?(worktreePath: string, signal?: AbortSignal): Promise<void>
  // The branch a session worktree is on and how many files it changed that
  // the source checkout never received: files differing between the merge
  // base with the source's HEAD and the worktree's HEAD. A branch the source
  // already merged says 0. Read before the worktree is removed at archive.
  sessionBranchFacts?(worktreePath: string, sourcePath: string, signal?: AbortSignal): Promise<SessionBranchFacts>
  checkpoint(worktreePath: string, label: string, signal?: AbortSignal): Promise<Checkpoint>
  // A checkpoint taken while an agent may be working: recorded under
  // refs/domovoi/checkpoints without moving HEAD or changing the index or files.
  snapshot?(worktreePath: string, label: string, signal?: AbortSignal): Promise<Checkpoint>
  restore(worktreePath: string, commit: string, signal?: AbortSignal): Promise<RestoreResult>
  revertFile?(worktreePath: string, path: string, signal?: AbortSignal, expectedBaseCommit?: string): Promise<FileRevert>
  // A person's commit of the session's work on its own branch, and only there
  // (GitWorkspaceService.commit). Refusals are SessionCommitRefusedError.
  commit?(worktreePath: string, request: SessionCommitRequest, signal?: AbortSignal): Promise<SessionCommit>
  evidence?(worktreePath: string, signal?: AbortSignal, includeRevertTargets?: boolean): Promise<WorkspaceEvidence>
  bundleSession?(
    worktreePath: string,
    bundlePath: string,
    sinceCommit?: string,
    signal?: AbortSignal,
    checkpointCommits?: readonly string[],
  ): Promise<SessionBundle>
  restoreSessionFromBundle?(
    bundlePath: string,
    sessionId: string,
    options: SessionBundleRestoreOptions,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace>
  pushSessionRef?(
    worktreePath: string,
    remote: string,
    sessionId: string,
    signal?: AbortSignal,
    checkpointCommits?: readonly string[],
  ): Promise<SessionRef>
  sessionHeadCommit?(sessionId: string, signal?: AbortSignal): Promise<string | undefined>
  restoreSessionFromRef?(
    repositoryPath: string,
    remote: string,
    sessionId: string,
    expectedCommitOrSignal?: string | AbortSignal,
    signal?: AbortSignal,
    checkpointCommits?: readonly string[],
  ): Promise<SessionWorkspace>
  transferFingerprint?(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<{ headCommit: string; digest: string }>
  countIgnoredTransferFiles?(
    worktreePath: string,
    promotedPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<number | undefined>
  projectHasLineage?(
    repositoryPath: string,
    lineageCommit: string,
    signal?: AbortSignal,
  ): Promise<boolean>
  readIgnoredArtifactSource?(
    worktreePath: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined>
  writeTransferredArtifactSource?(
    worktreePath: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>
}

export type SessionRef = {
  ref: string
  commit: string
  remote: string
}

export type SessionBundle = {
  path: string
  commit: string
  incremental: boolean
}

export type SessionBundleRestoreOptions = {
  // Import into the target project so the arrival remains one of its managed
  // worktrees. A standalone clone would keep the disposable bundle as origin.
  repositoryPath: string
  checkpointCommits?: readonly string[]
}

async function restrictBundlePermissions(path: string): Promise<void> {
  // A bundle holds every byte of the session worktree, so it is readable only
  // by the account that made it.
  if (process.platform === "win32") return
  await chmod(path, 0o600)
}

async function readBoundedFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const value of handle.createReadStream({ autoClose: false })) {
    signal?.throwIfAborted()
    const chunk = Buffer.from(value)
    byteLength += chunk.byteLength
    if (byteLength > maximumBytes) {
      throw new Error("Artifact source is unavailable for transfer")
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, byteLength)
}

// The protocol refuses an unsafe path at the wire, and this refuses it again at
// the boundary that actually runs git.
function isWorktreeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false
  if (path.startsWith("-") || path.includes("\0")) return false
  if (isAbsolute(path) || path.startsWith("/") || path.startsWith("\\")) return false
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false
  return path
    .split(/[\\/]/)
    .every((segment) => segment.length > 0 && segment !== ".." && segment !== ".")
}

function gitArguments(repositoryPath: string, arguments_: readonly string[]): string[] {
  return ["-C", repositoryPath, ...inertRepositoryConfig, ...arguments_]
}

async function git(
  repositoryPath: string,
  arguments_: string[],
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = {},
): Promise<string> {
  signal?.throwIfAborted()
  const env = { ...gitEnvironment(), ...environment }
  const result = await trackRestoreCommand(() => execute(gitCommand(env), gitArguments(repositoryPath, arguments_), {
    env,
    encoding: "utf8",
    maxBuffer: maximumGitOutputBytes,
    signal,
  }))
  return result.stdout.trim()
}

async function currentHead(worktreePath: string, signal?: AbortSignal): Promise<string | undefined> {
  const head = await git(worktreePath, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], signal).catch(() => "")
  return head || undefined
}


// The commit's whole tree, read in the isolated directory: in a partial clone
// a tree the repository lacks is fetched there, with the person's own
// transport settings, never through the repository's own config.
async function pathsAtCommit(isolated: IsolatedGit, commit: string, signal?: AbortSignal): Promise<Set<string>> {
  // NUL delimiters preserve spaces, tabs and newlines. Read the complete tree
  // under git's output/deadline bounds; a failed read must never mean absent.
  const tree = await boundedIsolatedGit(
    isolated,
    ["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit],
    maximumGitOutputBytes,
    signal,
  )
  if (tree.truncated) throw new Error("Git tree is too large to determine file revert targets")
  return new Set(tree.output.split("\0").filter(Boolean))
}

async function verifiedCheckpointRefs(
  repositoryPath: string,
  commits: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const unique = uniqueCheckpointCommits(commits)
  const refs = unique.map(checkpointRef)
  for (const [index, ref] of refs.entries()) {
    const resolved = await git(repositoryPath, ["rev-parse", `${ref}^{commit}`], signal)
    if (resolved !== unique[index]) {
      throw new Error("Transferred checkpoint ref does not match its commit")
    }
  }
  return refs
}

async function gitDirectory(
  directory: string,
  arguments_: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const env = gitEnvironment()
  const result = await execute(gitCommand(env), [`--git-dir=${directory}`, ...inertRepositoryConfig, ...arguments_], {
    env,
    encoding: "utf8",
    signal,
  })
  return result.stdout.trim()
}

// Git's output as it is, for NUL-delimited records whose first or last name
// may begin or end with whitespace.
async function rawGit(
  repositoryPath: string,
  arguments_: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const env = gitEnvironment()
  const result = await trackRestoreCommand(() => execute(gitCommand(env), gitArguments(repositoryPath, arguments_), {
    env,
    encoding: "utf8",
    maxBuffer: maximumGitOutputBytes,
    signal,
  }))
  return result.stdout
}

// Git's output in an isolated directory, cut at maximumBytes with a marker.
async function boundedIsolatedGit(
  isolated: IsolatedGit,
  arguments_: string[],
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ output: string; truncated: boolean }> {
  const output: Buffer[] = []
  let capturedBytes = 0
  let truncated = false
  const result = await isolated.stream(arguments_, (chunk, stop) => {
    const remaining = maximumBytes - capturedBytes
    if (remaining > 0) {
      const captured = chunk.subarray(0, remaining)
      output.push(captured)
      capturedBytes += captured.length
    }
    if (chunk.length > remaining && !truncated) {
      truncated = true
      stop()
    }
  }, { signal })
  if (result.code !== 0 && !truncated) throw new Error(result.stderr || `git exited with ${result.code ?? result.signal}`)
  let text = Buffer.concat(output).toString("utf8")
  if (truncated) {
    const marker = "…\n"
    while (Buffer.byteLength(`${text}${marker}`, "utf8") > maximumBytes) {
      text = text.slice(0, -1)
    }
    text += marker
  }
  return { output: text, truncated }
}

// The sha256 of Git's output in an isolated directory.
async function hashIsolatedGit(isolated: IsolatedGit, arguments_: string[], signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256")
  const result = await isolated.stream(arguments_, (chunk) => hash.update(chunk), { signal })
  if (result.code !== 0) throw new Error(result.stderr || `git exited with ${result.code ?? result.signal}`)
  return hash.digest("hex")
}

// Canonical change identity: raw NUL-delimited paths, status, old/new modes
// and full object IDs. Renames are delete plus add. Gitlinks and symlink
// targets participate through their object IDs, and no text decoding occurs.
async function stagedChangesDigest(isolated: IsolatedGit, baseCommit: string, index: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256").update("domovoi.commit-changes.v1\0").update(baseCommit).update("\0")
  const result = await isolated.stream([
    "--no-optional-locks", "diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames",
    "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", baseCommit, "--",
  ], (chunk) => { hash.update(chunk) }, { index, signal })
  if (result.code !== 0) throw new Error(result.stderr || `git diff exited with ${result.code ?? result.signal ?? "no status"}`)
  return `sha256:${hash.digest("hex")}`
}

// Both evidence and commits stage a private copy with the same index flags
// and staged gitlinks. Never refresh or rewrite the worktree's shared index.
async function seedPrivateIndex(isolated: IsolatedGit, sharedIndex: string, index: string, head: string | undefined, signal?: AbortSignal): Promise<boolean> {
  // Only the worktree's index itself being absent means there is none
  // (ruling Q295): nothing else that goes missing below does.
  const seed = await readIndexFile(sharedIndex)
  if (seed !== undefined) {
    await writeFile(index, seed)
    // A split index keeps most entries in a sharedindex.<hash> file, which
    // Git looks for beside the index it reads. The copy gets those files
    // too, and is then written whole (ruling Q281): the index published
    // from it must not name a shared index that lives only here. Git
    // removes expired ones on its own, so one that vanishes meanwhile is
    // passed over; if it was the one the index needs, rewriting the copy
    // whole fails, and so does the checkpoint.
    const shared = (await readdir(dirname(sharedIndex))).filter((name) => /^sharedindex\.[0-9a-f]+$/u.test(name))
    for (const name of shared) {
      await copyFile(join(dirname(sharedIndex), name), join(isolated.gitDirectory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
    if (shared.length > 0) await isolated.run(["update-index", "--no-split-index"], { index, signal })
    return true
  }
  await rm(index, { force: true })
  if (head !== undefined) await isolated.run(["read-tree", head], { index, signal })
  return false
}

// Observe the complete worktree without publishing an index or moving refs.
async function evidenceChangesDigest(isolated: IsolatedGit, baseCommit: string, deadline: OperationDeadline, signal?: AbortSignal): Promise<string | undefined> {
  const index = join(isolated.gitDirectory, "evidence-index")
  try {
    deadline.throwIfExpired()
    await seedPrivateIndex(isolated, isolated.worktreeIndex, index, baseCommit, deadline.signal)
    await isolated.run(["add", "--all"], { index, signal: deadline.signal })
    return await stagedChangesDigest(isolated, baseCommit, index, deadline.signal)
  } catch (error) {
    signal?.throwIfAborted()
    if (deadline.signal.aborted) return undefined
    // Git add's path refusal (1) or fatal staging failure (128) must not
    // hide otherwise readable evidence. No digest means no commit authority.
    const code = (error as { code?: unknown }).code
    if (code === 1 || code === 128) return undefined
    throw error
  }
}

// Reuse only within one observation, never at commit time. Include raw path
// bytes, the shared index and nanosecond ctime as well as mtime: rewriting
// same-sized bytes and restoring mtime must invalidate the staged object IDs.
// Gitlinks/directories need Git's own second staging pass to observe their
// nested HEADs. Unreadable metadata withholds authority, not the file view.
async function evidenceStagingState(worktree: string, isolated: IsolatedGit, signal?: AbortSignal): Promise<{
  fingerprint?: string; tooLarge: boolean
}> {
  const list = async (kind: "--cached" | "--modified") => {
    const chunks: Buffer[] = []
    let bytes = 0
    const result = await isolated.stream(["ls-files", kind, "--others", "--exclude-standard", "-z"], (chunk, stop) => {
      bytes += chunk.length
      if (bytes > maximumGitOutputBytes) { stop(); return }
      chunks.push(chunk)
    }, { signal })
    if (bytes > maximumGitOutputBytes) throw new Error("Git printed more evidence paths than Domovoi reads")
    if (result.code !== 0) throw new Error(result.stderr || "Git could not list evidence paths")
    return [...new Set(Buffer.concat(chunks).toString("binary").split("\0").filter(Boolean))].sort()
  }
  try {
    const [paths, changed, index] = await Promise.all([
      list("--cached"), list("--modified"), readIndexFile(isolated.worktreeIndex),
    ])
    const changedPaths = new Set(changed)
    const hash = createHash("sha256").update(index ?? "no-index")
    let bytes = 0n
    let reusable = true
    // Bound outstanding filesystem calls even for very large worktrees.
    for (let start = 0; start < paths.length; start += 64) {
      signal?.throwIfAborted()
      const batch = await Promise.all(paths.slice(start, start + 64).map(async (path) => {
        const raw = Buffer.from(path, "binary")
        const candidate = Buffer.concat([Buffer.from(`${worktree}${sep}`), raw])
        const stat = await lstat(candidate, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
          throw error
        })
        return { path, raw, stat }
      }))
      for (const { path, raw, stat } of batch) {
        hashField(hash, raw)
        if (!stat) { hashField(hash, "missing"); continue }
        if (!stat.isFile() && !stat.isSymbolicLink()) reusable = false
        if (changedPaths.has(path) && stat.isFile()) bytes += stat.size
        hashField(hash, `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
      }
    }
    return {
      ...(reusable ? { fingerprint: hash.digest("hex") } : {}),
      tooLarge: bytes > BigInt(maximumEvidenceStagingBytes),
    }
  } catch {
    signal?.throwIfAborted()
    return { tooLarge: true }
  }
}

// The `diff.<driver>.binary` settings Git reads in the worktree, as `-c`
// arguments for the evidence diffs in the isolated directory, which reads no
// repository config. A driver marked binary keeps a file's contents out of a
// diff and starts nothing; every other diff setting stays behind, and
// external diffs and text conversion stay off. A driver name Git's `-c` could
// not carry as written (an "=" or a control character) is left out.
async function diffBinarySettings(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
  let output: string
  try {
    output = await rawGit(worktreePath, ["config", "-z", "--type=bool", "--get-regexp", String.raw`^diff\..+\.binary$`], signal)
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return []
    throw error
  }
  return output.split("\0").filter((record) => record !== "").flatMap((record) => {
    const newline = record.indexOf("\n")
    const key = newline === -1 ? record : record.slice(0, newline)
    const value = newline === -1 ? "true" : record.slice(newline + 1)
    if (key.includes("=") || /[\p{Cc}]/u.test(key) || (value !== "true" && value !== "false")) return []
    return ["-c", `${key}=${value}`]
  })
}

// The isolated directory's HEAD must already be the worktree's HEAD the
// caller read: the status and diff compare against it.
async function workspaceEvidenceFingerprint(
  worktreePath: string,
  isolated: IsolatedGit,
  head: string,
  diffSettings: readonly string[],
  signal?: AbortSignal,
): Promise<{ headCommit: string; digest: string }> {
  const [baseCommit, status, diffHash] = await Promise.all([
    git(worktreePath, ["rev-parse", "HEAD"], signal),
    isolated.run(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", outsideSubmodules], { signal }).then((output) => output.trim()),
    hashIsolatedGit(isolated, [
      "--no-optional-locks",
      ...diffSettings,
      "diff",
      outsideSubmodules,
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      head,
      "--",
    ], signal),
  ])
  const digest = createHash("sha256")
    .update(baseCommit)
    .update("\0")
    .update(status)
    .update("\0")
    .update(diffHash)
    .digest("hex")
  return { headCommit: baseCommit, digest: `sha256:${digest}` }
}

function hashField(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value
  hash.update(String(bytes.byteLength)).update(":").update(bytes)
}

export function utf8GitPaths(bytes: Buffer): string[] {
  const paths: string[] = []
  let start = 0
  while (start < bytes.byteLength) {
    const separator = bytes.indexOf(0, start)
    const end = separator === -1 ? bytes.byteLength : separator
    const rawPath = bytes.subarray(start, end)
    if (rawPath.byteLength > 0) {
      const path = rawPath.toString("utf8")
      // Node string paths re-encode as UTF-8. Accepting a lossy decode here
      // would make the digest describe a missing replacement-character path
      // instead of the inode Git reported.
      if (!Buffer.from(path, "utf8").equals(rawPath)) {
        throw new Error("Git returned a path that is not valid UTF-8")
      }
      paths.push(path)
    }
    if (separator === -1) break
    start = separator + 1
  }
  return paths.sort()
}

function indexedGitlinks(bytes: Buffer): ReadonlyMap<string, string> {
  const gitlinks = new Map<string, string>()
  const content = bytes.at(-1) === 0 ? bytes.subarray(0, -1) : bytes
  if (content.byteLength === 0) return gitlinks
  for (const entry of content.toString("binary").split("\0")) {
    const separator = entry.indexOf("\t")
    if (separator === -1) throw new Error("Git returned a malformed index entry")
    const header = entry.slice(0, separator)
    if (!header.startsWith("160000 ")) continue
    const match = /^160000 ([a-f0-9]{40}) [0-3]$/u.exec(header)
    if (!match) throw new Error("Git returned a malformed gitlink entry")
    const rawPath = Buffer.from(entry.slice(separator + 1), "binary")
    const path = rawPath.toString("utf8")
    if (!Buffer.from(path, "utf8").equals(rawPath)) {
      throw new Error("Git returned a path that is not valid UTF-8")
    }
    gitlinks.set(path, match[1]!)
  }
  return gitlinks
}

async function transferWorktreeFingerprint(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<{ headCommit: string; digest: string }> {
  signal?.throwIfAborted()
  // One environment for the resolver and both children (ruling Q305).
  const env = gitEnvironment()
  const command = gitCommand(env)
  const [headCommit, listed, staged] = await Promise.all([
    git(worktreePath, ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], signal),
    execute(command, gitArguments(worktreePath, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]), { env, encoding: "buffer", maxBuffer: maximumGitOutputBytes, signal }),
    execute(command, gitArguments(worktreePath, [
      "ls-files",
      "--stage",
      "-z",
    ]), { env, encoding: "buffer", maxBuffer: maximumGitOutputBytes, signal }),
  ])
  const paths = utf8GitPaths(Buffer.from(listed.stdout))
  const gitlinks = indexedGitlinks(Buffer.from(staged.stdout))
  const hash = createHash("sha256").update("domovoi.transfer-worktree.v1\0")
  for (const path of paths) {
    signal?.throwIfAborted()
    const candidate = resolve(worktreePath, path)
    if (!pathStaysInside(worktreePath, candidate)) {
      throw new Error("Git returned a path outside the session worktree")
    }
    let metadata
    try {
      metadata = await lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // The fingerprint describes the effective tree that the checkpoint will
      // carry. A tracked deletion is absent both before and after committing it.
      continue
    }
    hashField(hash, path)
    if (metadata.isSymbolicLink()) {
      hashField(hash, "symlink")
      hashField(hash, await readlink(candidate))
      continue
    }
    if (metadata.isDirectory()) {
      // Git lists a directory here only for a tracked submodule. Its commit is
      // what the checkpoint and repository transfer carry, not its loose files.
      const commit = gitlinks.get(path)
      if (!commit) throw new Error("Git returned a directory without a gitlink entry")
      hashField(hash, "gitlink")
      hashField(hash, commit)
      continue
    }
    if (!metadata.isFile()) throw new Error("The session worktree contains an unsupported file")
    hashField(hash, "file")
    hashField(hash, metadata.mode & 0o111 ? "executable" : "regular")
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile()) throw new Error("The session worktree changed while it was hashed")
      hashField(hash, String(opened.size))
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted()
        hash.update(chunk)
      }
    } finally {
      await handle.close()
    }
  }
  return { headCommit, digest: `sha256:${hash.digest("hex")}` }
}

function pathStaysInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  )
}

function fieldsAndPath(record: string, fieldCount: number): { fields: string[]; path: string } {
  const fields: string[] = []
  let start = 0
  for (let index = 0; index < fieldCount; index += 1) {
    const end = record.indexOf(" ", start)
    if (end < 0) throw new Error("Git returned malformed status evidence")
    fields.push(record.slice(start, end))
    start = end + 1
  }
  return { fields, path: record.slice(start) }
}

function fileStatus(xy: string): ChangedFileEvidence["status"] {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflicted"
  if (xy.includes("R")) return "renamed"
  if (xy.includes("C")) return "copied"
  if (xy.includes("A")) return "added"
  if (xy.includes("D")) return "deleted"
  return "modified"
}

function parseStatus(output: string): Omit<ChangedFileEvidence, "additions" | "deletions" | "binary">[] {
  const records = output.split("\0")
  const files: Omit<ChangedFileEvidence, "additions" | "deletions" | "binary">[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith("? ")) {
      files.push({
        path: record.slice(2),
        status: "untracked",
        staged: false,
        unstaged: true,
      })
      continue
    }
    const kind = record[0]
    const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : 0
    if (!fieldCount) continue
    const { fields, path } = fieldsAndPath(record, fieldCount)
    const xy = fields[1] ?? ".."
    const previousPath = kind === "2" ? records[index += 1] : undefined
    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      status: fileStatus(xy),
      staged: xy[0] !== ".",
      unstaged: xy[1] !== ".",
    })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function parseNumstat(output: string): Map<string, {
  additions: number | null
  deletions: number | null
  binary: boolean
}> {
  const stats = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>()
  for (const record of output.split("\0")) {
    if (!record) continue
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    const path = record.slice(secondTab + 1)
    const binary = additions === "-" || deletions === "-"
    stats.set(path, {
      additions: binary ? null : Number(additions),
      deletions: binary ? null : Number(deletions),
      binary,
    })
  }
  return stats
}

export class GitWorkspaceService implements WorkspaceService {
  readonly worktreeRoot: string
  readonly #afterEvidenceObservation?: GitWorkspaceServiceOptions["afterEvidenceObservation"]
  readonly #afterCheckpointStaging?: GitWorkspaceServiceOptions["afterCheckpointStaging"]
  readonly #afterIgnoredArtifactValidation?: GitWorkspaceServiceOptions[
    "afterIgnoredArtifactValidation"
  ]
  readonly #afterNewWorktreeScan?: GitWorkspaceServiceOptions["afterNewWorktreeScan"]
  readonly #afterRepositoryFilterGate?: GitWorkspaceServiceOptions["afterRepositoryFilterGate"]
  readonly #afterRestoreReset?: GitWorkspaceServiceOptions["afterRestoreReset"]
  readonly #afterSessionCommit?: GitWorkspaceServiceOptions["afterSessionCommit"]
  readonly #repositoryTrust?: GitWorkspaceServiceOptions["repositoryTrust"]
  readonly #gitVersion: () => Promise<string | undefined>
  readonly #sessionRefTransferTimeoutMs: number
  readonly #evidenceStagingBudgetMs: number

  constructor(worktreeRoot: string, options: GitWorkspaceServiceOptions = {}) {
    this.#evidenceStagingBudgetMs = options.evidenceStagingBudgetMs ?? evidenceStagingBudgetMs
    this.#sessionRefTransferTimeoutMs = options.sessionRefTransferTimeoutMs ?? sessionRefTransferTimeoutMs
    this.worktreeRoot = resolve(worktreeRoot)
    this.#afterEvidenceObservation = options.afterEvidenceObservation
    this.#afterCheckpointStaging = options.afterCheckpointStaging
    this.#afterIgnoredArtifactValidation = options.afterIgnoredArtifactValidation
    this.#afterNewWorktreeScan = options.afterNewWorktreeScan
    this.#afterRepositoryFilterGate = options.afterRepositoryFilterGate
    this.#afterRestoreReset = options.afterRestoreReset
    this.#afterSessionCommit = options.afterSessionCommit
    this.#repositoryTrust = options.repositoryTrust
    this.#gitVersion = options.gitVersion ?? installedGitVersionText
  }

  #refuseLazyFetch(path: string, signal?: AbortSignal): Promise<void> {
    return refuseLazyFetch(path, this.#gitVersion, signal)
  }

  #gate(anchor: string, worktree: string, signal?: AbortSignal): Promise<RepositoryFilterGate> {
    return repositoryFilterGate({ worktree, anchor, trust: this.#repositoryTrust, signal })
  }

  // Refuses the rest of an operation once trust lapsed since its gate opened:
  // a revoke between the gate and a command it guards.
  #confirm(gate: RepositoryFilterGate): (() => void) | undefined {
    if (!gate.open || gate.reviewed.length === 0) return undefined
    return () => {
      const lapsed = gate.confirm()
      if (lapsed !== undefined) throw new RepositoryFilterRefusedError(gate.filters, { reason: lapsed, projectId: gate.projectId })
    }
  }

  // Runs `work` on an existing session worktree through an isolated Git
  // directory (isolated-checkout.ts) after its filter gate. A refused gate
  // refuses the operation; evidence, which stores nothing, reads with the
  // repository's filters absent instead ("filters-off"). `anchor` is the path
  // the caller named, which the trust lookup maps to its project.
  async #isolated<T>(
    anchor: string,
    worktree: string,
    signal: AbortSignal | undefined,
    work: (isolated: IsolatedGit) => Promise<T>,
    whenRefused: "refuse" | "filters-off" = "refuse",
    // A person's commit runs no filter the repository's own config sets, a
    // reviewed and trusted one included; it is refused instead, since staging
    // without the filter would commit what the filter exists to change.
    refuseRepositoryFilters?: () => Error,
  ): Promise<T> {
    await this.#refuseLazyFetch(worktree, signal)
    const gate = await this.#gate(anchor, worktree, signal)
    if (refuseRepositoryFilters && gate.filters.length > 0) throw refuseRepositoryFilters()
    if (!gate.open && whenRefused === "refuse") throw new RepositoryFilterRefusedError(gate.filters, { reason: gate.reason, projectId: gate.projectId })
    // Evidence can still be read without staging an unsafe submodule; its
    // own guard below withholds the digest in that case.
    if (whenRefused === "refuse") await refuseSubmoduleConfig(worktree, worktree, signal)
    await this.#afterRepositoryFilterGate?.(worktree)
    const isolated = await openIsolatedGit({
      worktree, temporaryObjects: whenRefused === "filters-off", reviewed: gate.open ? gate.reviewed : [], worktreeIndex: true, beforeCommand: this.#confirm(gate), signal,
    })
    try {
      return await work(isolated)
    } finally {
      await isolated.dispose()
    }
  }

  // Before a new session worktree is added: refuse with nothing made when the
  // checkout it is added from already reads a filter its trust does not cover.
  async #refuseBeforeAdding(anchor: string, directory: string, signal?: AbortSignal): Promise<void> {
    await this.#refuseLazyFetch(directory, signal)
    const gate = await this.#gate(anchor, directory, signal)
    if (!gate.open) {
      throw new RepositoryGitFilterRefusedError(gate.filters, { worktreeRemoved: true, branchRemoved: undefined }, { reason: gate.reason, projectId: gate.projectId })
    }
  }

  // A worktree added with --no-checkout holds no file yet, so nothing has run.
  // A scan of the checkout it was added from is not enough: an includeIf
  // "onbranch:" include applies to the new branch only, and `worktree add`
  // copies the source worktree's config.worktree. So the filter gate reads
  // Git's config as the new worktree reads it, and the worktree is checked out
  // only when the gate allows what that config sets: nothing, or a trusted
  // repository's reviewed filters exactly. Otherwise it is taken away, with
  // the branch this operation made (madeBranch), and refused (ruling Q3 A).
  //
  // The checkout itself runs in an isolated Git directory that reads none of
  // the repository's config (isolated-checkout.ts, ruling Q223), so config
  // written after the scan, and any repository key that would make Git or
  // git-lfs start a program, runs nothing; under trust only the reviewed
  // values the gate read are added.
  //
  // The checkout is of `commit` itself, and the new branch is set back to it
  // afterwards, so a branch moved in between checks out nothing else.
  async #checkOutNewWorktree(
    anchor: string,
    repositoryPath: string,
    path: string,
    commit: string,
    madeBranch: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    let gate: RepositoryFilterGate
    // The new worktree's index as it is now, before anything prepares the
    // checkout: the publish writes only over this same file (ruling Q281).
    let initialIndex: Buffer | undefined
    try {
      initialIndex = await readIndexFile(resolve(path, await git(path, ["rev-parse", "--git-path", "index"], signal)))
      gate = await this.#gate(anchor, path, signal)
      await this.#afterNewWorktreeScan?.(path)
      if (!gate.open) {
        throw new RepositoryGitFilterRefusedError(gate.filters, await discardNewWorktree(repositoryPath, path, madeBranch), {
          reason: gate.reason, projectId: gate.projectId,
        })
      }
    } catch (error) {
      if (!(error instanceof RepositoryGitFilterRefusedError)) await discardNewWorktree(repositoryPath, path, madeBranch)
      throw error
    }
    // A checkout that fails (a required filter of the person's own that
    // fails, a missing object, a cancel, trust revoked meanwhile) leaves no
    // worktree or branch behind: the caller's creation promise rejects and
    // never names one to remove.
    try {
      await checkOutIsolated({
        worktree: path, commit, reviewed: gate.open ? gate.reviewed : [], beforeCommand: this.#confirm(gate), signal, initialIndex,
      })
      await git(path, ["update-ref", "HEAD", commit], signal)
    } catch (error) {
      // A checkout ended by a cancel or a timeout had its process group
      // killed, and a process a filter started can have left that group, so
      // something may still write to the worktree. It is not deleted under
      // such a writer: it stays, with its branch, for recovery.
      if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) throw new NewWorktreeKeptError(error)
      // Removing the worktree would take a lock whose owner is unknown with it.
      if (error instanceof IndexLockHeldError) throw new NewWorktreeKeptError(error, "a Git command Domovoi cannot account for may hold its index lock")
      // Removing it would take that Git's index with it.
      if (error instanceof IndexChangedError) throw new NewWorktreeKeptError(error, "another Git wrote its index, which Domovoi did not replace")
      const cleanup = await discardNewWorktree(repositoryPath, path, madeBranch)
      if (error instanceof RepositoryFilterRefusedError) {
        throw new RepositoryGitFilterRefusedError(error.settings, cleanup, { reason: error.reason, projectId: error.projectId })
      }
      throw error
    }
  }

  async inspect(repositoryPath: string, signal?: AbortSignal): Promise<RepositoryInfo> {
    const root = await git(repositoryPath, ["rev-parse", "--show-toplevel"], signal)
    const [branch, head] = await Promise.all([
      git(root, ["branch", "--show-current"], signal),
      git(root, ["rev-parse", "HEAD"], signal),
    ])
    return { root, name: basename(root), branch, head }
  }

  async createSessionWorkspace(
    repositoryPath: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    return this.#withWorktreeClaim(sessionId,
      () => this.#createSessionWorkspace(repositoryPath, sessionId, signal), signal)
  }

  async #createSessionWorkspace(
    repositoryPath: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    if (!safeSessionId.test(sessionId)) {
      throw new Error("Session id is not safe for a worktree")
    }
    const repository = await this.inspect(repositoryPath, signal)
    await this.#refuseBeforeAdding(repositoryPath, repository.root, signal)
    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    await mkdir(this.worktreeRoot, { recursive: true })
    // The session-start history row must remain restorable and transferable.
    // Retain its commit before creating the worktree so a ref failure leaves no worktree behind.
    await git(repository.root, ["update-ref", `refs/domovoi/checkpoints/${repository.head}`, repository.head], signal)
    await git(repository.root, ["worktree", "add", "--no-checkout", "-b", branch, path, repository.head], signal)
    await this.#checkOutNewWorktree(repositoryPath, repository.root, path, repository.head, branch, signal)
    return { path, branch, baseCommit: repository.head }
  }

  async createSessionWorkspaceFromCheckpoint(
    sourceWorktreePath: string,
    checkpointCommit: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    return this.#withWorktreeClaim(sessionId,
      () => this.#createSessionWorkspaceFromCheckpoint(sourceWorktreePath, checkpointCommit, sessionId, signal), signal)
  }

  async #createSessionWorkspaceFromCheckpoint(
    sourceWorktreePath: string,
    checkpointCommit: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    if (!safeSessionId.test(sessionId)) throw new Error("Session id is not safe for a worktree")
    if (!/^[a-f0-9]{40}$/.test(checkpointCommit)) throw new Error("Checkpoint commit is invalid")
    await this.#refuseLazyFetch(sourceWorktreePath, signal)
    let durableCommit: string
    try {
      durableCommit = await git(sourceWorktreePath, [
        "rev-parse",
        `refs/domovoi/checkpoints/${checkpointCommit}^{commit}`,
      ], signal)
    } catch {
      signal?.throwIfAborted()
      throw new Error("Commit is not a Domovoi checkpoint")
    }
    if (durableCommit !== checkpointCommit) throw new Error("Commit is not a Domovoi checkpoint")

    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    try {
      const existingPath = await realpath(path)
      const [existingBranch, existingCommit] = await Promise.all([
        git(existingPath, ["branch", "--show-current"], signal),
        git(existingPath, ["rev-parse", "HEAD"], signal),
      ])
      if (existingBranch !== branch || existingCommit !== checkpointCommit) {
        throw new Error("Fork request conflicts with an existing session worktree")
      }
      return { path: existingPath, branch, baseCommit: checkpointCommit }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    const repository = await this.inspect(sourceWorktreePath, signal)
    await this.#refuseBeforeAdding(sourceWorktreePath, repository.root, signal)
    await mkdir(this.worktreeRoot, { recursive: true })
    let existingBranchCommit: string | undefined
    try {
      existingBranchCommit = await git(
        repository.root,
        ["rev-parse", `refs/heads/${branch}^{commit}`],
        signal,
      )
    } catch {
      signal?.throwIfAborted()
    }
    if (existingBranchCommit && existingBranchCommit !== checkpointCommit) {
      throw new Error("Fork request conflicts with an existing session branch")
    }
    await git(
      repository.root,
      existingBranchCommit
        ? ["worktree", "add", "--no-checkout", path, branch]
        : ["worktree", "add", "--no-checkout", "-b", branch, path, checkpointCommit],
      signal,
    )
    await this.#checkOutNewWorktree(sourceWorktreePath, repository.root, path, checkpointCommit, existingBranchCommit ? undefined : branch, signal)
    return { path: await realpath(path), branch, baseCommit: checkpointCommit }
  }

  // Evidence reads what the worktree shows and discards its staged blobs, so a filter
  // its trust does not cover is treated as absent there, not refused: the
  // file view may show a filtered file as changed. Under a grant the reviewed
  // filters read the files as a checkpoint would store them.
  async evidence(worktreePath: string, signal?: AbortSignal, includeRevertTargets = false): Promise<WorkspaceEvidence> {
    const deadline = OperationDeadline.start(this.#evidenceStagingBudgetMs, signal ? { signal } : {})
    try {
      return await this.#isolated(worktreePath, worktreePath, signal, (isolated) => this.#evidence(worktreePath, isolated, deadline, signal, includeRevertTargets), "filters-off")
    } finally {
      deadline.clear()
    }
  }

  async #evidence(worktreePath: string, isolated: IsolatedGit, deadline: OperationDeadline, signal: AbortSignal | undefined, includeRevertTargets: boolean): Promise<WorkspaceEvidence> {
    const diffSettings = await diffBinarySettings(worktreePath, signal)
    let canStage = true
    try {
      await refuseSubmoduleConfig(worktreePath, worktreePath, signal)
    } catch {
      signal?.throwIfAborted()
      // This guard authorizes staging, not the read-only file view. Any
      // failure withholds commit authorization while preserving that view.
      canStage = false
    }
    for (let attempt = 0; attempt < maximumEvidenceAttempts; attempt += 1) {
      // Every observation compares against this commit; the fingerprints
      // read the worktree's HEAD again, so one that moved meanwhile retries.
      const baseCommit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
      await isolated.setHead(baseCommit)
      const fingerprintBefore = await workspaceEvidenceFingerprint(worktreePath, isolated, baseCommit, diffSettings, signal)
      if (fingerprintBefore.headCommit !== baseCommit) continue
      const stagingBefore = canStage ? await evidenceStagingState(worktreePath, isolated, signal) : undefined
      const changesDigest = stagingBefore && !stagingBefore.tooLarge
        ? await evidenceChangesDigest(isolated, baseCommit, deadline, signal) : undefined
      const status = (await isolated.run([
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        outsideSubmodules,
      ], { signal })).trim()
      await this.#afterEvidenceObservation?.("status")
      const [numstat, diff, basePaths] = await Promise.all([
        isolated.run([
          "--no-optional-locks",
          ...diffSettings,
          "diff",
          outsideSubmodules,
          baseCommit,
          "--numstat",
          "-z",
          "--no-renames",
          "--no-textconv",
          "--",
        ], { signal }).then((output) => output.trim()),
        boundedIsolatedGit(
          isolated,
          [
            "--no-optional-locks",
            ...diffSettings,
            "diff",
            outsideSubmodules,
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            baseCommit,
            "--",
          ],
          maximumEvidenceDiffBytes,
          signal,
        ),
        includeRevertTargets ? pathsAtCommit(isolated, baseCommit, signal) : undefined,
      ])
      const stagingAfter = changesDigest === undefined ? undefined : await evidenceStagingState(worktreePath, isolated, signal)
      let changesDigestAfter: string | undefined
      if (changesDigest !== undefined && !stagingAfter?.tooLarge) {
        if (stagingBefore?.fingerprint === undefined) {
          changesDigestAfter = await evidenceChangesDigest(isolated, baseCommit, deadline, signal)
        } else if (stagingBefore.fingerprint === stagingAfter?.fingerprint) {
          changesDigestAfter = changesDigest
        }
      }
      const fingerprintAfter = await workspaceEvidenceFingerprint(worktreePath, isolated, baseCommit, diffSettings, signal)
      if (fingerprintBefore.digest !== fingerprintAfter.digest) continue
      const digestStable = changesDigest === changesDigestAfter
      if (!digestStable && attempt + 1 < maximumEvidenceAttempts) continue
      // Untracked bytes are not shown in the diff. If only those keep
      // changing, the view remains readable but cannot authorize a commit.

      const stats = parseNumstat(numstat)
      const allFiles: ChangedFileEvidence[] = parseStatus(status).map((file) => {
        const fileStats = stats.get(file.path)
        return {
          ...file,
          additions: fileStats?.additions ?? null,
          deletions: fileStats?.deletions ?? null,
          binary: fileStats?.binary ?? false,
        }
      })
      return {
        baseCommit,
        ...(changesDigest === undefined || !digestStable ? {} : { changesDigest }),
        diff: diff.output,
        diffTruncated: diff.truncated,
        totalChangedFiles: allFiles.length,
        files: allFiles.slice(0, maximumEvidenceFiles),
        filesTruncated: allFiles.length > maximumEvidenceFiles,
        ...(basePaths === undefined ? {} : {
          revertTargets: allFiles.slice(0, maximumEvidenceFiles).map((file) => ({
            path: file.path,
            kind: basePaths.has(file.path) ? "restore" as const : "remove" as const,
          })),
        }),
      }
    }
    throw new WorkspaceEvidenceUnstableError()
  }

  async transferFingerprint(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<{ headCommit: string; digest: string }> {
    for (let attempt = 0; attempt < maximumEvidenceAttempts; attempt += 1) {
      const before = await transferWorktreeFingerprint(worktreePath, signal)
      const after = await transferWorktreeFingerprint(worktreePath, signal)
      if (before.headCommit === after.headCommit && before.digest === after.digest) return after
    }
    throw new WorkspaceEvidenceUnstableError()
  }

  async projectHasLineage(
    repositoryPath: string,
    lineageCommit: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!/^[a-f0-9]{40}$/u.test(lineageCommit)) return false
    await this.#refuseLazyFetch(repositoryPath, signal)
    try {
      await git(repositoryPath, ["merge-base", "--is-ancestor", lineageCommit, "HEAD"], signal)
      return true
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }

  async countIgnoredTransferFiles(
    worktreePath: string,
    promotedPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    try {
      signal?.throwIfAborted()
      const root = await realpath(worktreePath)
      const promoted = new Set<string>()
      for (const path of promotedPaths) {
        signal?.throwIfAborted()
        // Resolve casing as well as a possible symlink in the worktree root.
        // Files that vanished after their bytes were collected cannot appear
        // in the inventory, so there is nothing to subtract for them.
        const canonical = await realpath(resolve(root, path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (canonical) promoted.add(Buffer.from(relative(root, canonical).split(sep).join("/")).toString("hex"))
      }
      // One environment for the resolver and the child (ruling Q305).
      const env = gitEnvironment()
      const { stdout } = await execute(gitCommand(env), gitArguments(root, [
        "ls-files", "-z", "--others", "--ignored", "--exclude-standard",
      ]), { env, encoding: "buffer", maxBuffer: maximumGitOutputBytes, signal })
      let count = 0
      let start = 0
      // NUL framing also counts filenames containing newlines or non-UTF-8
      // bytes. Decoding those names could confuse them with a promoted path.
      for (let end = stdout.indexOf(0); end !== -1; end = stdout.indexOf(0, start)) {
        if (!promoted.has(stdout.subarray(start, end).toString("hex"))) count += 1
        start = end + 1
      }
      return count
    } catch {
      signal?.throwIfAborted()
      // A failed or oversized inventory is unknown, not zero. It must not
      // prevent a transfer whose required resources passed preflight.
      return undefined
    }
  }

  async readIgnoredArtifactSource(
    worktreePath: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    signal?.throwIfAborted()
    if (!isWorktreeRelativePath(path)) {
      throw new Error("Artifact path must stay inside the session worktree")
    }
    const root = await realpath(worktreePath)
    const lexicalPath = resolve(root, path)
    if (!pathStaysInside(root, lexicalPath)) {
      throw new Error("Artifact path must stay inside the session worktree")
    }
    let metadata: Awaited<ReturnType<typeof lstat>>
    let canonicalPath: string
    try {
      [metadata, canonicalPath] = await Promise.all([lstat(lexicalPath), realpath(lexicalPath)])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || !pathStaysInside(root, canonicalPath)
      || metadata.size > maximumPreviewSourceBytes
    ) {
      throw new Error("Artifact source is unavailable for transfer")
    }
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(lexicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("Artifact source is unavailable for transfer", { cause: error })
      }
      throw error
    }
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile()
        || opened.dev !== metadata.dev
        || opened.ino !== metadata.ino
        || opened.size > maximumPreviewSourceBytes
      ) {
        throw new Error("Artifact source is unavailable for transfer")
      }
      try {
        await git(root, ["check-ignore", "--quiet", "--", path], signal)
      } catch (error) {
        signal?.throwIfAborted()
        if ((error as { code?: unknown }).code === 1) return undefined
        throw error
      }
      await this.#afterIgnoredArtifactValidation?.()
      const bytes = await readBoundedFileHandle(handle, maximumPreviewSourceBytes, signal)
      const after = await handle.stat()
      if (
        bytes.byteLength !== opened.size
        || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs
      ) {
        throw new Error("Artifact source is unavailable for transfer")
      }
      return bytes
    } finally {
      await handle.close()
    }
  }

  async writeTransferredArtifactSource(
    worktreePath: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (!isWorktreeRelativePath(path) || bytes.byteLength > maximumPreviewSourceBytes) {
      throw new Error("Artifact path must stay inside the session worktree")
    }
    const root = await realpath(worktreePath)
    const lexicalPath = resolve(root, path)
    if (!pathStaysInside(root, lexicalPath)) {
      throw new Error("Artifact path must stay inside the session worktree")
    }
    let parent = root
    const parentFromRoot = relative(root, dirname(lexicalPath))
    for (const segment of parentFromRoot === "" ? [] : parentFromRoot.split(sep)) {
      parent = join(parent, segment)
      try {
        await mkdir(parent, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const [metadata, canonicalParent] = await Promise.all([lstat(parent), realpath(parent)])
      if (
        !metadata.isDirectory()
        || metadata.isSymbolicLink()
        || !pathStaysInside(root, canonicalParent)
      ) {
        throw new Error("Artifact path must stay inside the session worktree")
      }
    }
    try {
      await writeFile(lexicalPath, bytes, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const metadata = await lstat(lexicalPath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Transferred artifact source conflicts with an existing file", {
          cause: error,
        })
      }
      const existing = await readFile(lexicalPath)
      if (!existing.equals(Buffer.from(bytes))) {
        throw new Error("Transferred artifact source conflicts with an existing file", {
          cause: error,
        })
      }
    }
  }

  async checkpoint(worktreePath: string, label: string, signal?: AbortSignal): Promise<Checkpoint> {
    return this.#isolated(worktreePath, worktreePath, signal, (isolated) => this.#checkpoint(worktreePath, label, isolated, signal))
  }

  // Stages the whole worktree through the isolated directory, where only the
  // filters its gate allowed can run, then commits with plumbing that reads
  // no file. Staging and the commit use an index of the checkpoint's own,
  // seeded from the worktree's index (so the person's staging and files
  // tracked despite an ignore rule are in it) and kept in the isolated
  // directory, which goes with it (ruling Q276). The worktree's own index is
  // never written while the checkpoint runs, so a failed checkpoint has
  // nothing to put back, and nothing another Git wrote meanwhile is undone.
  async #checkpoint(worktreePath: string, label: string, isolated: IsolatedGit, signal?: AbortSignal): Promise<Checkpoint> {
    const { commit, changedFiles } = await this.#commitWorktree(worktreePath, isolated, { message: `chore(domovoi): checkpoint ${label}` }, signal)
    return { commit, changedFiles }
  }

  // A person's commit of a session's work (walk finding F10, ruled
  // 2026-10-18). The agent's sandbox cannot write a linked worktree's Git
  // metadata, and is kept that way, so Domovoi makes the commit: on the
  // session branch, domovoi/<sessionId>, and nothing else. The worktree must be
  // this session's own under the worktree root, its HEAD must name that branch,
  // and the branch must still be at the commit the person's view of the
  // changes was read against. It is staged and committed as a checkpoint is
  // (filter gate, isolated Git directory, inert hooks, unsigned), every path
  // it adds or changes must be one the thread can show (no secret file), and
  // only that branch moves, from expectedHead. Nothing is pushed.
  async commit(worktreePath: string, request: SessionCommitRequest, signal?: AbortSignal): Promise<SessionCommit> {
    signal?.throwIfAborted()
    const { sessionId, expectedHead } = request
    if (!safeSessionId.test(sessionId) || !commitSha.test(expectedHead)) throw new SessionCommitRefusedError("not-session-worktree")
    // The message stays in the branch's history wherever it goes, so one the
    // durable-text redactor would change is refused, never committed.
    if (redactDurableText(request.message).redacted || request.message.includes("\0")) throw new SessionCommitRefusedError("secret-message")
    const expectedPath = this.sessionWorkspacePath(sessionId)
    let path: string
    try {
      if ((await lstat(expectedPath)).isSymbolicLink()) throw new SessionCommitRefusedError("not-session-worktree")
      const [expected, recorded] = await Promise.all([realpath(expectedPath), realpath(resolve(worktreePath))])
      if (recorded !== expected) throw new SessionCommitRefusedError("not-session-worktree")
      path = recorded
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionCommitRefusedError("not-session-worktree")
      throw error
    }
    if (await this.#resolveManagedWorktree(path, signal) === undefined) throw new SessionCommitRefusedError("not-session-worktree")
    // A linked worktree of the session's own repository, registered there: its
    // Git directory is <common>/worktrees/<name>, that directory points back at
    // this worktree, and the common directory is the project's. An ordinary
    // checkout or another repository's worktree at this path is refused.
    if (!await this.#linkedWorktreeOf(path, request.repositoryPath, signal)) throw new SessionCommitRefusedError("not-session-worktree")
    const branch = `domovoi/${sessionId}`
    const ref = `refs/heads/${branch}`
    const onSessionBranch = async () => {
      const named = await git(path, ["symbolic-ref", "-q", "HEAD"], signal).catch(() => "")
      // The session ref itself must hold a commit: one made a symbolic ref to
      // another branch would carry the commit there.
      const symbolic = await git(path, ["symbolic-ref", "-q", ref], signal).then(() => true, () => false)
      return named === ref && !symbolic
    }
    const outcome: { made?: SessionCommit } = {}
    try {
      return await this.#isolated(path, path, signal, async (isolated) => {
        if (!await onSessionBranch()) throw new SessionCommitRefusedError("not-session-branch", branch)
        const head = await git(path, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], signal).catch(() => "")
        if (head !== expectedHead) throw new SessionCommitRefusedError("head-moved", branch)
        // Whatever the isolated directory holds back from the repository's
        // own config could make the commit store something other than Git
        // would (a blanked filter stores plaintext), so the commit refuses,
        // decided from the config read the directory was built from (ruling
        // Q140), before anything is staged.
        refuseHeldBackConfig(await isolated.heldBack({ signal }), branch)
        outcome.made = await this.#commitWorktree(path, isolated, {
          message: request.message,
          branch: { ref, head, stillCurrent: onSessionBranch },
          author: await personIdentity(path, signal),
        refuse: async (index, changedFiles) => {
          if (changedFiles.length === 0) throw new SessionCommitRefusedError("nothing-to-commit", branch)
          // The directory staged with the config it read when it opened; a
          // setting the repository gained since was not applied. So the
          // worktree's config is read again now, before anything is written.
          refuseHeldBackConfig(await isolated.heldBack({ reread: true, signal }), branch)
          // Every changed path, read as raw bytes, so one that is not UTF-8,
          // a deleted one included, is refused rather than recorded under a
          // replacement character. Every submodule entry counts, whatever
          // .gitmodules or config says to ignore: write-tree commits what the
          // index holds.
          const changedPaths = async (filter: readonly string[]) => {
            const output: Buffer[] = []
            let bytes = 0
            const result = await isolated.stream(
              ["--no-optional-locks", "diff", "--cached", "--name-only", "--no-renames", ...filter, "--ignore-submodules=none", "-z"],
              (chunk, stop) => {
                bytes += chunk.byteLength
                if (bytes > maximumGitOutputBytes) stop()
                else output.push(chunk)
              },
              { index, signal: signal ?? null },
            )
            if (bytes > maximumGitOutputBytes) throw new SessionCommitRefusedError("unreadable-paths", branch)
            if (result.code !== 0) throw new Error(result.stderr || `git diff exited with ${result.code ?? result.signal ?? "no status"}`)
            try {
              return utf8GitPaths(Buffer.concat(output))
            } catch {
              throw new SessionCommitRefusedError("unreadable-paths", branch)
            }
          }
          await changedPaths([])
          // The paths whose contents enter the commit: a deletion carries no
          // contents, so dropping a tracked secret file is allowed.
          const written = await changedPaths(["--diff-filter=d"])
          const secret = written.filter((candidate) => !checkpointPathIsSafe(candidate)).length
          if (secret > 0) throw new SessionCommitRefusedError("secret-paths", branch, secret)
          if (request.expectedChangesDigest !== await stagedChangesDigest(isolated, head, index, signal)) {
            throw new SessionCommitRefusedError("changes-moved", branch)
          }
        },
      }, signal).then(({ commit, changedFiles, afterCommitError }) => ({
        commit, branch, changedFiles, ...(afterCommitError === undefined ? {} : { afterCommitError }),
      }))
        return outcome.made
      }, "refuse", () => new SessionCommitRefusedError("repository-filters", branch))
    } catch (error) {
      // Once the branch has moved the commit exists, so a failure after it,
      // such as cleaning up the isolated directory, is reported with it and
      // never as a commit that did not happen.
      const { made } = outcome
      if (made === undefined) throw error
      return { ...made, afterCommitError: made.afterCommitError ?? (error instanceof Error ? error.message : String(error)) }
    }
  }

  async #linkedWorktreeOf(path: string, repositoryPath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const [gitDir, common, projectCommon] = await Promise.all([
        git(path, ["rev-parse", "--path-format=absolute", "--git-dir"], signal),
        git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
        git(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
      ])
      const [gitDirectory, commonDirectory, projectDirectory] = await Promise.all([realpath(gitDir), realpath(common), realpath(projectCommon)])
      if (commonDirectory !== projectDirectory || gitDirectory === commonDirectory) return false
      if (dirname(gitDirectory) !== join(commonDirectory, "worktrees")) return false
      // The worktree's own .git file, not a link to another worktree's, and
      // the registration's backlink names this directory's .git by its place.
      const dotGit = await lstat(join(path, ".git"))
      if (!dotGit.isFile()) return false
      const backlink = resolve(gitDirectory, (await readFile(join(gitDirectory, "gitdir"), "utf8")).trim())
      return basename(backlink) === ".git" && await realpath(dirname(backlink)) === path
    } catch {
      return false
    }
  }

  // Stages the whole worktree and commits it on HEAD, or on options.branch
  // only, from the commit it must still be at. Shared by checkpoints and a
  // person's commit; see #checkpoint for how the index is handled.
  async #commitWorktree(worktreePath: string, isolated: IsolatedGit, options: WorktreeCommitOptions, signal?: AbortSignal): Promise<Checkpoint & { afterCommitError?: string }> {
    const head = options.branch ? options.branch.head : await currentHead(worktreePath, signal)
    const sharedIndex = resolve(worktreePath, await git(worktreePath, ["rev-parse", "--git-path", "index"], signal))
    const index = join(isolated.gitDirectory, "checkpoint-index")
    // The entries the worktree's index held at the start, as `ls-files`
    // lists them: what a later writer is detected by. Stat data a refresh
    // rewrites does not count. Git lists paths as their raw bytes, so the
    // comparison is of a digest of the raw output, never of decoded text, in
    // which two paths that are not UTF-8 can read alike (ruling Q281).
    const entries = async (path: string) => {
      const digest = createHash("sha256")
      const result = await isolated.stream(["ls-files", "--stage", "-v", "-z"], (chunk) => { digest.update(chunk) }, { index: path, signal: null })
      if (result.code !== 0) throw new Error(result.stderr || `git ls-files exited with ${result.code ?? result.signal ?? "no status"}`)
      return digest.digest("hex")
    }
    let seeded: string
    if (await seedPrivateIndex(isolated, sharedIndex, index, head, signal)) {
      seeded = await entries(index)
    } else {
      // No index lists no entry: the digest of nothing.
      seeded = createHash("sha256").digest("hex")
    }
    if (head !== undefined) await isolated.setHead(head)
    await isolated.run(["add", "--all"], { index, signal })
    await this.#afterCheckpointStaging?.()
    // A person's commit lists every submodule entry it commits, whatever the
    // repository asks Git to ignore; a checkpoint lists as it always has.
    const names = await isolated.run(["--no-optional-locks", "diff", "--cached", "--name-only", ...(options.branch ? ["--ignore-submodules=none"] : []), "-z"], { index, signal })
    const changedFiles = names.split("\0").filter(Boolean)
    await options.refuse?.(index, changedFiles)
    if (options.branch) {
      if (changedFiles.length === 0) throw new Error("A commit needs a change; refuse() decides that first")
      const made = await commitIndex(worktreePath, isolated, head, options.message, signal, index, options.branch.ref, options.author)
      // The commit is on the session branch now, so nothing below may lose it:
      // a failure is returned with it, and the abort signal no longer applies.
      try {
        // The checkpoint ref itself, never a ref it might point at.
        await git(worktreePath, ["update-ref", "--no-deref", `refs/domovoi/checkpoints/${made}`, made])
        await this.#afterSessionCommit?.(worktreePath)
        // Read under the index lock: a HEAD switched away meanwhile keeps its
        // own index, even one whose entries match what Domovoi read.
        const head = { left: false }
        const stillCurrent = options.branch.stillCurrent
        await publishUnderIndexLock(sharedIndex, () => readFile(index), async () => {
          head.left = !await stillCurrent()
          return !head.left && await entries(sharedIndex) === seeded
        })
        if (head.left) {
          return { commit: made, changedFiles, afterCommitError: `The worktree left ${options.branch.ref.slice("refs/heads/".length)} while Domovoi committed, so its index was left as it was.` }
        }
      } catch (error) {
        return { commit: made, changedFiles, afterCommitError: error instanceof Error ? error.message : String(error) }
      }
      return { commit: made, changedFiles }
    }
    if (changedFiles.length > 0) await commitIndex(worktreePath, isolated, head, options.message, signal, index)
    const commit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
    await git(worktreePath, ["update-ref", "--no-deref", `refs/domovoi/checkpoints/${commit}`, commit], signal)
    // Then the worktree's index becomes the checkpoint's, as Git would write
    // it, so the worktree reads as clean. Only while it still holds the
    // entries it had at the start: a lock already there, or another Git's
    // write since, leaves it as that Git left it. The checkpoint stands
    // either way; the status then shows its files against the new HEAD.
    try {
      // An absent index lists no entry, as one seeded from nothing does.
      await publishUnderIndexLock(sharedIndex, () => readFile(index), async () => await entries(sharedIndex) === seeded)
    } catch (error) {
      if (error instanceof IndexPublishedNotDurableError) throw new Error(`Domovoi made checkpoint ${commit} and put the worktree's index at it. ${error.message}`, { cause: error })
      throw new Error(`Domovoi made checkpoint ${commit}, but could not update the worktree's index to it: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return { commit, changedFiles }
  }

  // The worktree as a checkpoint commit whose parent is HEAD, built in a
  // temporary index. HEAD, the branch, the shared index and every file stay as
  // they were, so an agent mid-turn sees nothing. The temporary index starts as
  // a copy of the shared one, so files tracked despite an ignore rule stay in.
  async snapshot(worktreePath: string, label: string, signal?: AbortSignal): Promise<Checkpoint & { matched: boolean }> {
    return this.#isolated(worktreePath, worktreePath, signal, (isolated) => this.#snapshot(worktreePath, label, isolated, signal))
  }

  async #snapshot(worktreePath: string, label: string, isolated: IsolatedGit, signal?: AbortSignal): Promise<Checkpoint & { matched: boolean }> {
    const head = await currentHead(worktreePath, signal)
    if (head !== undefined) await isolated.setHead(head)
    if (await submoduleHasLocalChanges(worktreePath, signal)) throw new SubmoduleChangesRefusedError()
    const sharedIndex = resolve(worktreePath, await git(worktreePath, ["rev-parse", "--git-path", "index"], signal))
    const temporaryIndex = resolve(
      worktreePath,
      await git(worktreePath, ["rev-parse", "--git-path", `domovoi-snapshot-${randomUUID()}.index`], signal),
    )
    try {
      try {
        await copyFile(sharedIndex, temporaryIndex)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await isolated.run(["read-tree", head ?? "--empty"], { index: temporaryIndex, signal })
      }
      const seedIndex = await readFile(temporaryIndex)
      // Every Git command that reads or writes the temporary index runs in the
      // isolated directory: writing an index can run a clean filter.
      let tree = ""
      let matched = false
      const changedDuringCapture = new Set<string>()
      // Bound the observation window. A matching pair is not an atomic
      // filesystem snapshot: a write that reverts between passes is missed.
      // Reset the same temporary index to its original tracked set on retry.
      // Otherwise an early untracked addition stays tracked when a later pass
      // should exclude it under newly written ignore rules.
      for (let pass = 0; pass < 4; pass += 1) {
        if (pass > 0) await writeFile(temporaryIndex, seedIndex)
        await isolated.run(["add", "--all"], { index: temporaryIndex, signal })
        await this.#afterCheckpointStaging?.()
        const nextTree = (await isolated.run(["write-tree"], { index: temporaryIndex, signal })).trim()
        if (tree === nextTree) {
          matched = true
          break
        }
        if (tree) {
          const differences = await isolated.run(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", tree, nextTree, "--"], { signal })
          for (const path of differences.split("\0").filter(Boolean)) changedDuringCapture.add(path)
        }
        tree = nextTree
      }
      // Against the HEAD captured above, not whatever HEAD is now: the agent may
      // commit meanwhile, and the snapshot's parent is the captured one.
      const names = await isolated.run(head === undefined
        ? ["ls-files", "-z"]
        : ["--no-optional-locks", "diff", "--cached", "--no-renames", "--name-only", "-z", head, "--"], { index: temporaryIndex, signal })
      const changedFiles = names.split("\0").filter(Boolean)
      let commit = head
      if (commit === undefined || changedFiles.length > 0) {
        commit = await git(worktreePath, [
          "-c",
          "user.name=Domovoi",
          "-c",
          "user.email=domovoi@localhost",
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          "--no-gpg-sign",
          tree,
          ...(head === undefined ? [] : ["-p", head]),
          "-m",
          `chore(domovoi): checkpoint ${label}`,
        ], signal)
      }
      await git(worktreePath, ["update-ref", checkpointRef(commit), commit], signal)
      return { commit, changedFiles, matched, ...(!matched ? { unstablePaths: [...changedDuringCapture].sort() } : {}) }
    } catch (error) {
      if (isolated.indexLocksLeft.includes(`${temporaryIndex}.lock`) && error instanceof Error) {
        error.message = `${error.message} Domovoi left the temporary index ${temporaryIndex} in place with it.`
      }
      throw error
    } finally {
      // A lock a killed command left may be another Git's now (ruling Q265):
      // it and the index under it stay.
      const locked = isolated.indexLocksLeft.includes(`${temporaryIndex}.lock`)
      for (const path of locked ? [] : [temporaryIndex, `${temporaryIndex}.lock`]) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      }
    }
  }

  // What this machine already holds for a session, so a source can send only
  // what is missing. A session it has never seen is not an error.
  async sessionHeadCommit(sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    if (!safeSessionId.test(sessionId)) return undefined
    const path = join(this.worktreeRoot, sessionId)
    try {
      await realpath(path)
    } catch {
      // A cancelled lookup is not the same as a session this machine lacks.
      signal?.throwIfAborted()
      return undefined
    }
    try {
      return await git(path, ["rev-parse", "HEAD"], signal)
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
  }

  // The opt-in path: pushing a session to a Git remote the caller names. It is
  // never the default, because a remote is a third place the repository lands
  // and the user has to choose it deliberately.
  async pushSessionRef(
    worktreePath: string,
    remote: string,
    sessionId: string,
    signal?: AbortSignal,
    checkpointCommits?: readonly string[],
  ): Promise<SessionRef> {
    if (!safeSessionId.test(sessionId)) throw new Error("Session id is not safe for a worktree")
    // A remote name that begins with a dash would be read as an option by git.
    if (!safeRemoteName.test(remote)) throw new Error("Remote name is not safe")

    const { commit, transport } = await this.#isolated(worktreePath, worktreePath, signal, async (isolated) => {
      const transport = await repositoryTransportOverrides(worktreePath, "remote", signal)
      const remotes = await git(worktreePath, ["remote"], signal)
      if (!remotes.split("\n").map((name) => name.trim()).includes(remote)) {
        throw new Error(`Repository has no remote named ${remote}`)
      }
      await refuseRemoteAddresses(worktreePath, remote, signal)
      return { commit: await this.#checkpointedHead(worktreePath, isolated, signal), transport }
    })

    const ref = `refs/domovoi/sessions/${sessionId}`
    const checkpointRefs = await verifiedCheckpointRefs(
      worktreePath,
      checkpointCommits,
      signal,
    )
    // Content-addressed checkpoint refs go first. The session ref is the
    // publication marker, so a remote that rejects one checkpoint never
    // advertises an incomplete session transfer. This does not require the
    // remote to support atomic pushes.
    if (checkpointRefs.length > 0) {
      await this.#boundedPush(worktreePath, [
        ...transport,
        "push",
        "--",
        remote,
        ...checkpointRefs.map((checkpoint) => `${checkpoint}:${checkpoint}`),
      ], signal)
    }
    await this.#boundedPush(worktreePath, [...transport, "push", "--", remote, `${commit}:${ref}`], signal)
    return { ref, commit, remote }
  }

  // One push, stopped at the transfer deadline as well as by the caller's
  // signal, so a remote that never answers cannot hold it forever. It runs
  // as an isolated command does (runGitProcess): a stop ends its process
  // group, or on Windows its process tree, where git.exe is a launcher whose
  // child would otherwise keep the push, and its output pipes, open.
  async #boundedPush(worktreePath: string, arguments_: string[], signal?: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(this.#sessionRefTransferTimeoutMs)
    try {
      const result = await trackRestoreCommand(() => runGitProcess(gitArguments(worktreePath, arguments_), {
        env: gitEnvironment(), cwd: worktreePath, signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      }))
      if (result.code !== 0) {
        throw Object.assign(new Error(result.stderr || `git push exited with ${result.code ?? result.signal ?? "no status"}`), {
          code: result.code ?? undefined, stderr: result.stderr,
        })
      }
    } catch (error) {
      if (!deadline.aborted || signal?.aborted === true) throw error
      const seconds = Math.ceil(this.#sessionRefTransferTimeoutMs / 1000)
      throw new Error(`git push did not finish within ${seconds} seconds, so Domovoi stopped it. Check that the remote answers, then try again.`, { cause: error })
    }
  }

  // The target side of the opt-in path: the session arrives through the remote
  // both machines already share, not as bytes over the daemon connection.
  async restoreSessionFromRef(
    repositoryPath: string,
    remote: string,
    sessionId: string,
    expectedCommitOrSignal?: string | AbortSignal,
    signal?: AbortSignal,
    checkpointCommits?: readonly string[],
  ): Promise<SessionWorkspace> {
    const expectedCommit = typeof expectedCommitOrSignal === "string"
      ? expectedCommitOrSignal
      : undefined
    const operationSignal = typeof expectedCommitOrSignal === "string"
      ? signal
      : expectedCommitOrSignal ?? signal
    if (!safeSessionId.test(sessionId)) throw new Error("Session id is not safe for a worktree")
    await this.#refuseBeforeAdding(repositoryPath, repositoryPath, operationSignal)
    if (!safeRemoteName.test(remote)) throw new Error("Remote name is not safe")
    if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/u.test(expectedCommit)) {
      throw new Error("Expected remote session commit is invalid")
    }

    const ref = `refs/domovoi/sessions/${sessionId}`
    const checkpointRefs = uniqueCheckpointCommits(checkpointCommits).map(checkpointRef)
    const transport = await repositoryTransportOverrides(repositoryPath, "remote", operationSignal)
    await refuseRemoteAddresses(repositoryPath, remote, operationSignal)
    // Submodules are not fetched: that would run in each submodule under its
    // own config.
    await git(repositoryPath, [
      ...transport,
      "fetch",
      "--quiet",
      "--atomic",
      "--no-recurse-submodules",
      "--",
      remote,
      `${ref}:${ref}`,
      ...checkpointRefs.map((checkpoint) => `${checkpoint}:${checkpoint}`),
    ], operationSignal)
    const commit = await git(repositoryPath, ["rev-parse", `${ref}^{commit}`], operationSignal)
    if (expectedCommit !== undefined && commit !== expectedCommit) {
      throw new Error("Remote session ref changed before transfer commit")
    }
    await verifiedCheckpointRefs(repositoryPath, checkpointCommits, operationSignal)

    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    await mkdir(this.worktreeRoot, { recursive: true })
    const held = await this.sessionHeadCommit(sessionId, operationSignal)
    if (held !== undefined) {
      const status = await this.#isolated(repositoryPath, path, operationSignal, async (isolated) => {
        await isolated.setHead(held)
        const changed = (await isolated.run(["--no-optional-locks", "status", "--porcelain", outsideSubmodules], { signal: operationSignal })).trim()
        return changed !== "" || await submoduleHasLocalChanges(path, operationSignal) ? "changed" : ""
      })
      if (held !== commit || status.length > 0) throw new SessionWorktreeExistsError()
      await git(path, ["update-ref", `refs/domovoi/checkpoints/${commit}`, commit], operationSignal)
      return { path, branch, baseCommit: commit }
    }
    try {
      await realpath(path)
      throw new SessionWorktreeExistsError()
    } catch (error) {
      if (error instanceof SessionWorktreeExistsError) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    await git(repositoryPath, ["worktree", "add", "--no-checkout", "-b", branch, path, commit], operationSignal)
    await this.#checkOutNewWorktree(repositoryPath, repositoryPath, path, commit, branch, operationSignal)
    // The transferred checkpoint stays restorable here, as it does when a
    // session arrives as a bundle.
    await git(path, ["update-ref", `refs/domovoi/checkpoints/${commit}`, commit], operationSignal)
    return { path, branch, baseCommit: commit }
  }

  // A bundle or a pushed ref carries commits, so anything not committed would
  // be left behind on the source. The session must be at a checkpoint before
  // it travels. The status reads files, so it runs in the isolated directory.
  async #checkpointedHead(worktreePath: string, isolated: IsolatedGit, signal?: AbortSignal): Promise<string> {
    const commit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
    let durableCommit: string | undefined
    try {
      durableCommit = await git(worktreePath, [
        "rev-parse",
        `refs/domovoi/checkpoints/${commit}^{commit}`,
      ], signal)
    } catch {
      signal?.throwIfAborted()
    }
    await isolated.setHead(commit)
    const status = (await isolated.run(["--no-optional-locks", "status", "--porcelain", outsideSubmodules], { signal })).trim()
    if (durableCommit !== commit || status.length > 0 || await submoduleHasLocalChanges(worktreePath, signal)) {
      throw new Error("Session worktree has work that is not checkpointed")
    }
    return commit
  }

  // Repository bytes travel daemon to daemon as a Git bundle, so a transfer
  // never puts them on a remote the user did not choose.
  async bundleSession(
    worktreePath: string,
    bundlePath: string,
    sinceCommit?: string,
    signal?: AbortSignal,
    checkpointCommits?: readonly string[],
  ): Promise<SessionBundle> {
    // The caller names where the bundle goes, but a path that walks upward can
    // land somewhere it was never meant to, so traversal is refused outright.
    if (!isAbsolute(bundlePath) || bundlePath.split(/[\\/]/).includes("..")) {
      throw new Error("Bundle path must not traverse")
    }
    const resolved = resolve(bundlePath)
    if (sinceCommit !== undefined && !/^[a-f0-9]{40}$/.test(sinceCommit)) {
      throw new Error("Bundle base commit is invalid")
    }

    // The bundle is written in the isolated directory, from object ids: its
    // HEAD is the checkpointed commit, and each checkpoint ref is made there
    // from the commit the repository's ref was verified to name. It runs
    // offline: packing a partial clone's history can need a promised object
    // the clone never fetched, and fetching it would follow the repository's
    // own promisor remote and transport settings. The transfer fails instead.
    const commit = await this.#isolated(worktreePath, worktreePath, signal, async (isolated) => {
      const commit = await this.#checkpointedHead(worktreePath, isolated, signal)
      const checkpointRefs = await verifiedCheckpointRefs(worktreePath, checkpointCommits, signal)
      const commits = uniqueCheckpointCommits(checkpointCommits)
      for (const [index, ref] of checkpointRefs.entries()) {
        await isolated.run(["update-ref", ref, commits[index]!], { signal, offline: true })
      }
      const revisions = sinceCommit === undefined
        ? ["HEAD", ...checkpointRefs]
        : [`^${sinceCommit}`, "HEAD", ...checkpointRefs]
      await isolated.run(["bundle", "create", "--quiet", resolved, ...revisions], { signal, offline: true })
      return commit
    })
    await restrictBundlePermissions(resolved)
    return { path: resolved, commit, incremental: sinceCommit !== undefined }
  }

  // The target imports bundle bytes into its own project repository. The
  // arrival remains a managed worktree with durable remotes after the
  // disposable transfer package is removed.
  async restoreSessionFromBundle(
    bundlePath: string,
    sessionId: string,
    options: SessionBundleRestoreOptions,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    return this.#withWorktreeClaim(sessionId,
      () => this.#restoreClaimedSessionFromBundle(bundlePath, sessionId, options, signal), signal)
  }

  sessionWorkspacePath(sessionId: string): string {
    if (!safeSessionId.test(sessionId)) throw new Error("Session id is not safe for a worktree")
    return join(this.worktreeRoot, sessionId)
  }

  async validateCreatedSessionWorkspace(
    repositoryPath: string,
    sessionId: string,
    workspace: SessionWorkspace,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    return this.#withWorktreeClaim(sessionId, async () => {
      const expectedPath = this.sessionWorkspacePath(sessionId)
      if ((await lstat(expectedPath)).isSymbolicLink()) throw new Error("Created worktree was replaced by a symlink")
      const [expected, path] = await Promise.all([realpath(expectedPath), realpath(workspace.path)])
      if (path !== expected) throw new Error("Created worktree moved outside its recorded session location")
      const [repositoryCommon, workspaceCommon, branch, head, topLevel] = await Promise.all([
        git(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
        git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
        git(path, ["branch", "--show-current"], signal),
        git(path, ["rev-parse", "HEAD"], signal),
        git(path, ["rev-parse", "--show-toplevel"], signal),
      ])
      if (await realpath(repositoryCommon) !== await realpath(workspaceCommon)
        || await realpath(topLevel) !== path || branch !== `domovoi/${sessionId}`
        || branch !== workspace.branch || head !== workspace.baseCommit) {
        throw new Error("Created worktree no longer matches its repository and completion receipt")
      }
      return { ...workspace, path }
    }, signal)
  }

  async #withWorktreeClaim<T>(sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!safeSessionId.test(sessionId)) {
      throw new Error("Session id is not safe for a worktree")
    }
    signal?.throwIfAborted()
    const claimDirectory = join(this.worktreeRoot, ".restore-claims")
    const claimPath = join(claimDirectory, sessionId)
    const claimToken = randomUUID()
    const active = activeBundleRestores.get(claimPath)
    if (active?.state === "quarantined") throw new SessionRestoreClaimQuarantinedError(claimPath)
    if (active) throw new SessionWorktreeExistsError()
    const reservation: RestoreClaimReservation = { state: "restoring" }
    activeBundleRestores.set(claimPath, reservation)
    let lease: RestoreOperationLease | undefined
    let claim: Awaited<ReturnType<typeof open>> | undefined
    let claimTokenWritten = false
    let outcome: { completed: true; value: T } | { completed: false; error: unknown }
    let cleanupErrors: unknown[] = []
    try {
      lease = new RestoreOperationLease(this.worktreeRoot, sessionId, claimToken)
      await mkdir(claimDirectory, { recursive: true })
      signal?.throwIfAborted()
      try {
        // The filesystem claim also excludes independent daemon processes.
        // Never wait, steal a timed-out claim, or remove another owner's file.
        claim = await open(claimPath, "wx", 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SessionWorktreeExistsError(claimPath)
        throw error
      }
      // Once the file exists, finish its identity even if the restore was
      // cancelled. Otherwise cancellation itself leaves an unverified claim
      // that cleanup cannot safely remove. No repository work starts below
      // until the caller's cancellation has been checked again.
      const writeSignal = AbortSignal.timeout(restoreClaimIoTimeoutMs)
      await claim.writeFile(claimToken, { encoding: "utf8", signal: writeSignal })
      claimTokenWritten = true
      writeSignal.throwIfAborted()
      signal?.throwIfAborted()
      outcome = { completed: true, value: await lease.run(operation) }
    } catch (error) {
      outcome = { completed: false, error }
    } finally {
      if (claim) {
        cleanupErrors = await releaseRestoreClaim(claim, claimPath, claimToken, claimTokenWritten, reservation, lease!)
      } else {
        activeBundleRestores.delete(claimPath)
        lease?.release()
      }
    }
    if (cleanupErrors.length > 0) {
      // Preserve even frozen or non-Error failures without mutating them.
      throw new SessionRestoreClaimCleanupError(claimPath, cleanupErrors, outcome.completed ? undefined : outcome)
    }
    if (!outcome.completed) throw outcome.error
    return outcome.value
  }

  async #restoreClaimedSessionFromBundle(
    bundlePath: string,
    sessionId: string,
    options: SessionBundleRestoreOptions,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    await this.#refuseBeforeAdding(options.repositoryPath, options.repositoryPath, signal)
    const repository = await this.inspect(options.repositoryPath, signal)
    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    // Each restore owns its temporary ref, so concurrent attempts cannot
    // delete or retarget one another's fetched commit.
    const incomingPrefix = `refs/domovoi/incoming/${sessionId}/${randomUUID()}`
    const incomingRef = `${incomingPrefix}/head`
    const declaredCheckpoints = uniqueCheckpointCommits(options.checkpointCommits)
    const incomingCheckpoints = declaredCheckpoints.map((commit) => ({
      commit,
      source: checkpointRef(commit),
      target: `${incomingPrefix}/checkpoints/${commit}`,
    }))
    // The file transport is allowed only for this path, the bundle Domovoi
    // received, and only while it is a regular file: a repository directory
    // there would start a serving side with that repository's own config.
    // It also runs offline: a prerequisite the bundle names and this
    // repository lacks fails the fetch, instead of being fetched lazily from a
    // promisor remote the repository's config names, whose serving side that
    // config would choose. Submodules are not fetched: that would run in each
    // submodule under its own config.
    const transport = await repositoryTransportOverrides(repository.root, "bundle", signal)
    const bundle = await lstat(bundlePath).catch(() => undefined)
    if (!bundle?.isFile()) throw new Error("Bundle could not be verified")
    try {
      await git(repository.root, [
        ...transport,
        "fetch",
        "--quiet",
        "--atomic",
        "--no-recurse-submodules",
        "--",
        bundlePath,
        `+HEAD:${incomingRef}`,
        ...incomingCheckpoints.map(({ source, target }) => `+${source}:${target}`),
      ], signal, { GIT_NO_LAZY_FETCH: "1" })
    } catch {
      signal?.throwIfAborted()
      throw new Error("Bundle could not be verified")
    }

    try {
      const arrived = await git(repository.root, ["rev-parse", `${incomingRef}^{commit}`], signal)
      for (const checkpoint of incomingCheckpoints) {
        const resolved = await git(
          repository.root,
          ["rev-parse", `${checkpoint.target}^{commit}`],
          signal,
        )
        if (resolved !== checkpoint.commit) {
          throw new Error("Transferred checkpoint ref does not match its commit")
        }
      }
      const installCheckpointRefs = async (): Promise<void> => {
        for (const commit of new Set([...declaredCheckpoints, arrived])) {
          await git(repository.root, ["update-ref", checkpointRef(commit), commit], signal)
        }
      }
      // An incremental bundle applies only to the managed worktree this target
      // already owns. Uncommitted target work is never this transfer's to drop.
      const held = await this.sessionHeadCommit(sessionId, signal)
      if (held !== undefined) {
        // `checkout -B <branch> <arrived>` in two parts: the files and the
        // index through the isolated directory, where only filters the gate
        // allowed run, then the branch and HEAD with ref commands. The
        // worktree is clean, so a hard reset changes what checkout would.
        await this.#isolated(options.repositoryPath, path, signal, async (isolated) => {
          const [worktreeCommon, repositoryCommon] = await Promise.all([
            git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
            git(repository.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
          ])
          if (await realpath(worktreeCommon) !== await realpath(repositoryCommon)) throw new SessionWorktreeExistsError()
          await isolated.setHead(held)
          const status = (await isolated.run(["status", "--porcelain", outsideSubmodules], { signal })).trim()
          if (status.length > 0 || await submoduleHasLocalChanges(path, signal)) throw new SessionWorktreeExistsError()
          await isolated.run(["reset", "--hard", "--quiet", arrived], { signal })
        })
        await git(path, ["update-ref", "-m", `checkout: moving to ${branch}`, `refs/heads/${branch}`, arrived], signal)
        await git(path, ["symbolic-ref", "HEAD", `refs/heads/${branch}`], signal)
        await installCheckpointRefs()
        return { path, branch, baseCommit: arrived }
      }

      try {
        await realpath(path)
        throw new SessionWorktreeExistsError()
      } catch (error) {
        if (error instanceof SessionWorktreeExistsError) throw error
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }

      try {
        await git(repository.root, ["worktree", "add", "--no-checkout", "-b", branch, path, arrived], signal)
      } catch (error) {
        // A concurrent restore can win either the branch or path. The loser
        // must never clean up the winner's worktree.
        const detail = error instanceof Error ? error.message : ""
        if (/already exists|already checked out/u.test(detail)) {
          throw new SessionWorktreeExistsError()
        }
        throw error
      }
      await this.#checkOutNewWorktree(options.repositoryPath, repository.root, path, arrived, branch, signal)
      await installCheckpointRefs()
      return { path, branch, baseCommit: arrived }
    } finally {
      for (const ref of [incomingRef, ...incomingCheckpoints.map(({ target }) => target)]) {
        await git(repository.root, ["update-ref", "-d", ref]).catch(() => {})
      }
    }
  }

  async restore(worktreePath: string, commit: string, signal?: AbortSignal): Promise<RestoreResult> {
    if (!/^[a-f0-9]{40}$/.test(commit)) {
      throw new Error("Checkpoint commit is invalid")
    }
    return this.#isolated(worktreePath, worktreePath, signal, async (isolated) => {
      let checkpointCommit: string
      try {
        checkpointCommit = await git(worktreePath, [
          "rev-parse",
          `refs/domovoi/checkpoints/${commit}^{commit}`,
        ], signal)
      } catch {
        signal?.throwIfAborted()
        throw new Error("Commit is not a Domovoi checkpoint")
      }
      if (checkpointCommit !== commit) {
        throw new Error("Commit is not a Domovoi checkpoint")
      }
      // The recovery checkpoint records a submodule by its commit and the
      // reset leaves its files alone, so a submodule's local changes would
      // survive the restore unrecorded: refused, as a snapshot refuses them.
      if (await submoduleHasLocalChanges(worktreePath, signal)) throw new SubmoduleChangesRefusedError()
      const recovery = await this.#checkpoint(worktreePath, "before restore", isolated, signal)
      // `reset --hard` in two parts: the files and the index through the
      // isolated directory, then the branch with a ref command.
      await isolated.setHead(recovery.commit)
      await isolated.run(["reset", "--hard", "--quiet", checkpointCommit], { signal })
      await this.#afterRestoreReset?.()
      // The files and the index now hold the checkpoint, so the branch is
      // moved to it whatever the signal says, and the operation state reset
      // --hard clears is cleared: stopping here would leave a worktree that
      // disagrees with its branch.
      try {
        await git(worktreePath, ["update-ref", "-m", `reset: moving to ${checkpointCommit}`, "HEAD", checkpointCommit])
      } catch (cause) {
        throw new Error(
          `Restore wrote checkpoint ${checkpointCommit.slice(0, 8)} into the worktree and its index, but could not move the branch `
          + `from ${recovery.commit.slice(0, 8)} to it. The work from before the restore is in checkpoint ${recovery.commit.slice(0, 8)}.`,
          { cause },
        )
      }
      await clearOperationState(worktreePath)
      return { restoredCommit: checkpointCommit, recoveryCommit: recovery.commit }
    })
  }

  // Reverting one file discards uncommitted work, so the recovery checkpoint is
  // taken before anything in the worktree moves, and every step after it either
  // completes or throws. The checkpoint commits the whole worktree, so HEAD is
  // put back where it was afterwards and only the named file is changed.
  async revertFile(
    worktreePath: string,
    path: string,
    signal?: AbortSignal,
    expectedBaseCommit?: string,
  ): Promise<FileRevert> {
    if (!isWorktreeRelativePath(path)) {
      throw new Error("File path must stay inside the session worktree")
    }
    return this.#isolated(worktreePath, worktreePath, signal, async (isolated) => {
      const pathspec = `:(literal)${path}`
      const baseCommit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
      if (expectedBaseCommit !== undefined && baseCommit !== expectedBaseCommit) {
        throw new FileRevertTargetChangedError()
      }
      await isolated.setHead(baseCommit)
      const status = (await isolated.run([
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=all",
        outsideSubmodules,
        "--",
        pathspec,
      ], { signal })).trim()
      if (status.length === 0) throw new Error("File has no changes to revert")

      let tracked = true
      try {
        await isolated.run(["cat-file", "-e", `${baseCommit}:${path}`], { signal })
      } catch {
        signal?.throwIfAborted()
        tracked = false
      }

      const recovery = await this.#checkpoint(worktreePath, `before revert ${path}`, isolated, signal)
      // The checkpoint moved HEAD onto the work being reverted. Putting HEAD back
      // keeps the session where it was, and leaves the recovery commit reachable
      // only through its durable checkpoint ref. As `reset --soft`, it leaves
      // the index and the files alone; the file itself then changes through
      // the isolated directory.
      try {
        await git(worktreePath, ["update-ref", "-m", `reset: moving to ${baseCommit}`, "HEAD", baseCommit], signal)
        await isolated.setHead(baseCommit)
        if (tracked) {
          await isolated.run(["checkout", baseCommit, "--", pathspec], { signal })
        } else {
          await isolated.run(["rm", "--force", "--quiet", "--", pathspec], { signal })
        }
      } catch (cause) {
        throw new FileRevertIncompleteError(recovery.commit, { cause })
      }
      return {
        path,
        outcome: tracked ? "restored" as const : "removed" as const,
        baseCommit,
        recoveryCommit: recovery.commit,
      }
    })
  }

  async removeSessionWorkspace(worktreePath: string, signal?: AbortSignal): Promise<void> {
    const resolved = await this.#resolveManagedWorktree(worktreePath, signal)
    if (!resolved) return
    const { path, commonDirectory } = resolved
    const branch = await git(path, ["branch", "--show-current"], signal)
    await gitDirectory(commonDirectory, ["worktree", "remove", "--force", path], signal)
    if (branch.startsWith("domovoi/")) {
      await gitDirectory(commonDirectory, ["branch", "-D", branch], signal)
    }
  }

  async sessionBranchFacts(worktreePath: string, sourcePath: string, signal?: AbortSignal): Promise<SessionBranchFacts> {
    const resolved = await this.#resolveManagedWorktree(worktreePath, signal)
    if (!resolved) throw new Error("Session worktree does not exist")
    await this.#refuseLazyFetch(resolved.path, signal)
    await this.#refuseLazyFetch(sourcePath, signal)
    const branch = await git(resolved.path, ["branch", "--show-current"], signal)
    if (!branch) throw new Error("Session worktree is not on a branch")
    // The checkout the session came from, which may itself be a linked
    // worktree: its HEAD, not the main checkout's, is what received the work.
    const sourceHead = await git(sourcePath, ["rev-parse", "HEAD"], signal)
    const mergeBase = await git(resolved.path, ["merge-base", sourceHead, "HEAD"], signal)
    // Submodule updates count whatever the repository's diff settings say, and
    // the NUL-delimited names are read untrimmed, so a name of spaces counts.
    const names = await rawGit(resolved.path, ["diff", "--name-only", "-z", "--ignore-submodules=none", mergeBase, "HEAD"], signal)
    return { branch, unmergedFiles: names.split("\0").filter(Boolean).length }
  }


  // `worktree remove --force` skips the clean check, so it runs no filter and
  // nothing here is refused: a session whose archive checkpoint was taken can
  // finish archiving after its repository's trust was revoked.
  async archiveSessionWorkspace(worktreePath: string, signal?: AbortSignal): Promise<void> {
    const resolved = await this.#resolveManagedWorktree(worktreePath, signal)
    if (!resolved) return
    await gitDirectory(
      resolved.commonDirectory,
      ["worktree", "remove", "--force", resolved.path],
      signal,
    )
  }

  async #resolveManagedWorktree(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; commonDirectory: string } | undefined> {
    signal?.throwIfAborted()
    let path: string
    try {
      path = await realpath(resolve(worktreePath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    const root = await realpath(this.worktreeRoot)
    const pathFromRoot = relative(root, path)
    if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new Error("Worktree path is outside the Domovoi worktree root")
    }
    const repositoryRoot = await git(path, ["rev-parse", "--show-toplevel"], signal)
    if (await realpath(repositoryRoot) !== path) {
      throw new Error("Worktree path does not identify a Git worktree root")
    }
    const commonDirectory = await git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ], signal)
    return { path, commonDirectory }
  }
}
