import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import { maximumPreviewSourceBytes } from "@getdomovoi/protocol"

const execute = promisify(execFile)
const safeSessionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const safeRemoteName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const commitSha = /^[a-f0-9]{40}$/u
// Reserve synchronously before the first await, across service instances.
// Otherwise a delayed claim opener could acquire after the winner completes
// and turn a concurrent request into an apparently sequential update.
const activeBundleRestores = new Set<string>()

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

export type Checkpoint = {
  commit: string
  changedFiles: string[]
}

export type RestoreResult = {
  restoredCommit: string
  recoveryCommit: string
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
  baseCommit: string
  diff: string
  diffTruncated: boolean
  totalChangedFiles: number
  files: ChangedFileEvidence[]
  filesTruncated: boolean
}

export const maximumEvidenceFiles = 200
export const maximumEvidenceDiffBytes = 256 * 1_024
const maximumEvidenceAttempts = 3
const maximumGitOutputBytes = 32 * 1_024 * 1_024

export class SessionWorktreeExistsError extends Error {
  constructor(restoreClaimPath?: string) {
    super(restoreClaimPath === undefined
      ? "Session worktree already exists"
      : `Session worktree already exists or its restore claim is held at ${restoreClaimPath}. Stop Domovoi and its supervisor before removing a confirmed stale claim.`)
    this.name = "SessionWorktreeExistsError"
  }
}

export class SessionRestoreClaimCleanupError extends AggregateError {
  readonly restoreCompleted: boolean

  constructor(
    readonly claimPath: string,
    cleanupErrors: readonly unknown[],
    restoreFailure?: { error: unknown },
  ) {
    const diagnostic = `Restore claim cleanup failed at ${claimPath}`
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

export class WorkspaceEvidenceUnstableError extends Error {
  constructor() {
    super("Workspace changed while evidence was collected")
    this.name = "WorkspaceEvidenceUnstableError"
  }
}

export type GitWorkspaceServiceOptions = {
  afterEvidenceObservation?: (observation: "status") => void | Promise<void>
  afterCheckpointStaging?: () => void | Promise<void>
  afterIgnoredArtifactValidation?: () => void | Promise<void>
}

export interface WorkspaceService {
  inspect(repositoryPath: string, signal?: AbortSignal): Promise<RepositoryInfo>
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
  checkpoint(worktreePath: string, label: string, signal?: AbortSignal): Promise<Checkpoint>
  restore(worktreePath: string, commit: string, signal?: AbortSignal): Promise<RestoreResult>
  revertFile?(worktreePath: string, path: string, signal?: AbortSignal): Promise<FileRevert>
  evidence?(worktreePath: string, signal?: AbortSignal): Promise<WorkspaceEvidence>
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

async function git(
  repositoryPath: string,
  arguments_: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const result = await execute("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
    maxBuffer: maximumGitOutputBytes,
    signal,
  })
  return result.stdout.trim()
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
  const result = await execute("git", [`--git-dir=${directory}`, ...arguments_], {
    encoding: "utf8",
    signal,
  })
  return result.stdout.trim()
}

async function boundedGit(
  repositoryPath: string,
  arguments_: string[],
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ output: string; truncated: boolean }> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", repositoryPath, ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let capturedBytes = 0
    let truncated = false
    let settled = false
    const abort = () => child.kill()
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maximumBytes - capturedBytes
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining)
        output.push(captured)
        capturedBytes += captured.length
      }
      if (chunk.length > remaining && !truncated) {
        truncated = true
        child.stdout.destroy()
        child.kill()
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const captured = errors.reduce((total, value) => total + value.length, 0)
      if (captured < 16_384) errors.push(chunk.subarray(0, 16_384 - captured))
    })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      if (code !== 0 && !truncated) {
        reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `git exited with ${code}`))
        return
      }
      let text = Buffer.concat(output).toString("utf8")
      if (truncated) {
        const marker = "…\n"
        while (Buffer.byteLength(`${text}${marker}`, "utf8") > maximumBytes) {
          text = text.slice(0, -1)
        }
        text += marker
      }
      resolvePromise({ output: text, truncated })
    })
  })
}

async function hashGit(
  repositoryPath: string,
  arguments_: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", repositoryPath, ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const hash = createHash("sha256")
    const errors: Buffer[] = []
    let capturedErrorBytes = 0
    let settled = false
    const abort = () => child.kill()
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => hash.update(chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      if (capturedErrorBytes >= 16_384) return
      const captured = chunk.subarray(0, 16_384 - capturedErrorBytes)
      errors.push(captured)
      capturedErrorBytes += captured.length
    })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      if (code !== 0) {
        reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `git exited with ${code}`))
        return
      }
      resolvePromise(hash.digest("hex"))
    })
  })
}

async function workspaceEvidenceFingerprint(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<{ headCommit: string; digest: string }> {
  const fingerprintConfig = [
    "-c",
    "core.fsmonitor=false",
  ]
  const [baseCommit, status, diffHash] = await Promise.all([
    git(worktreePath, [...fingerprintConfig, "rev-parse", "HEAD"], signal),
    git(worktreePath, [
      ...fingerprintConfig,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ], signal),
    hashGit(worktreePath, [
      ...fingerprintConfig,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "HEAD",
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
  const [headCommit, listed, staged] = await Promise.all([
    git(worktreePath, ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], signal),
    execute("git", [
      "-C",
      worktreePath,
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ], { encoding: "buffer", maxBuffer: maximumGitOutputBytes, signal }),
    execute("git", [
      "-C",
      worktreePath,
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--stage",
      "-z",
    ], { encoding: "buffer", maxBuffer: maximumGitOutputBytes, signal }),
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

  constructor(worktreeRoot: string, options: GitWorkspaceServiceOptions = {}) {
    this.worktreeRoot = resolve(worktreeRoot)
    this.#afterEvidenceObservation = options.afterEvidenceObservation
    this.#afterCheckpointStaging = options.afterCheckpointStaging
    this.#afterIgnoredArtifactValidation = options.afterIgnoredArtifactValidation
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
    if (!safeSessionId.test(sessionId)) {
      throw new Error("Session id is not safe for a worktree")
    }
    const repository = await this.inspect(repositoryPath, signal)
    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    await mkdir(this.worktreeRoot, { recursive: true })
    await git(repository.root, ["worktree", "add", "-b", branch, path, repository.head], signal)
    return { path, branch, baseCommit: repository.head }
  }

  async createSessionWorkspaceFromCheckpoint(
    sourceWorktreePath: string,
    checkpointCommit: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    if (!safeSessionId.test(sessionId)) throw new Error("Session id is not safe for a worktree")
    if (!/^[a-f0-9]{40}$/.test(checkpointCommit)) throw new Error("Checkpoint commit is invalid")
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
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, checkpointCommit],
      signal,
    )
    return { path: await realpath(path), branch, baseCommit: checkpointCommit }
  }

  async evidence(worktreePath: string, signal?: AbortSignal): Promise<WorkspaceEvidence> {
    for (let attempt = 0; attempt < maximumEvidenceAttempts; attempt += 1) {
      const fingerprintBefore = await workspaceEvidenceFingerprint(worktreePath, signal)
      const [baseCommit, status] = await Promise.all([
        git(worktreePath, ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], signal),
        git(worktreePath, [
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
        ], signal),
      ])
      await this.#afterEvidenceObservation?.("status")
      const [numstat, diff] = await Promise.all([
        git(worktreePath, [
          "-c",
          "core.fsmonitor=false",
          "diff",
          "HEAD",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-textconv",
          "--",
        ], signal),
        boundedGit(
          worktreePath,
          [
            "-c",
            "core.fsmonitor=false",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "HEAD",
            "--",
          ],
          maximumEvidenceDiffBytes,
          signal,
        ),
      ])
      const fingerprintAfter = await workspaceEvidenceFingerprint(worktreePath, signal)
      if (fingerprintBefore.digest !== fingerprintAfter.digest) continue

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
        diff: diff.output,
        diffTruncated: diff.truncated,
        totalChangedFiles: allFiles.length,
        files: allFiles.slice(0, maximumEvidenceFiles),
        filesTruncated: allFiles.length > maximumEvidenceFiles,
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
    try {
      await git(repositoryPath, ["merge-base", "--is-ancestor", lineageCommit, "HEAD"], signal)
      return true
    } catch {
      signal?.throwIfAborted()
      return false
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
    await git(worktreePath, ["add", "--all"], signal)
    await this.#afterCheckpointStaging?.()
    let names: string
    try {
      names = await git(worktreePath, ["diff", "--cached", "--name-only", "-z"], signal)
    } catch (error) {
      // Everything is staged by now; a failed checkpoint must not leave it so.
      await git(worktreePath, ["reset", "-q"]).catch(() => undefined)
      throw error
    }
    const changedFiles = names.split("\0").filter(Boolean)
    if (changedFiles.length === 0) {
      const commit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
      await git(worktreePath, ["update-ref", `refs/domovoi/checkpoints/${commit}`, commit], signal)
      return { commit, changedFiles }
    }

    await git(worktreePath, [
      "-c",
      "user.name=Domovoi",
      "-c",
      "user.email=domovoi@localhost",
      "commit",
      "-m",
      `chore(domovoi): checkpoint ${label}`,
    ], signal)
    const commit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
    await git(worktreePath, ["update-ref", `refs/domovoi/checkpoints/${commit}`, commit], signal)
    return { commit, changedFiles }
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

    const remotes = await git(worktreePath, ["remote"], signal)
    if (!remotes.split("\n").map((name) => name.trim()).includes(remote)) {
      throw new Error(`Repository has no remote named ${remote}`)
    }

    const commit = await this.#checkpointedHead(worktreePath, signal)
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
      await git(worktreePath, [
        "push",
        "--",
        remote,
        ...checkpointRefs.map((checkpoint) => `${checkpoint}:${checkpoint}`),
      ], signal)
    }
    await git(worktreePath, ["push", "--", remote, `${commit}:${ref}`], signal)
    return { ref, commit, remote }
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
    if (!safeRemoteName.test(remote)) throw new Error("Remote name is not safe")
    if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/u.test(expectedCommit)) {
      throw new Error("Expected remote session commit is invalid")
    }

    const ref = `refs/domovoi/sessions/${sessionId}`
    const checkpointRefs = uniqueCheckpointCommits(checkpointCommits).map(checkpointRef)
    await git(repositoryPath, [
      "fetch",
      "--quiet",
      "--atomic",
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
      const status = await git(path, ["status", "--porcelain"], operationSignal)
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

    await git(repositoryPath, ["worktree", "add", "-b", branch, path, commit], operationSignal)
    // The transferred checkpoint stays restorable here, as it does when a
    // session arrives as a bundle.
    await git(path, ["update-ref", `refs/domovoi/checkpoints/${commit}`, commit], operationSignal)
    return { path, branch, baseCommit: commit }
  }

  async #checkpointedHead(worktreePath: string, signal?: AbortSignal): Promise<string> {
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
    const status = await git(worktreePath, ["status", "--porcelain"], signal)
    if (durableCommit !== commit || status.length > 0) {
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

    const commit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
    // A bundle carries commits, so anything not committed would be left behind
    // on the source. The session must be at a checkpoint before it travels.
    let durableCommit: string | undefined
    try {
      durableCommit = await git(worktreePath, [
        "rev-parse",
        `refs/domovoi/checkpoints/${commit}^{commit}`,
      ], signal)
    } catch {
      signal?.throwIfAborted()
    }
    const status = await git(worktreePath, ["status", "--porcelain"], signal)
    if (durableCommit !== commit || status.length > 0) {
      throw new Error("Session worktree has work that is not checkpointed")
    }

    const checkpointRefs = await verifiedCheckpointRefs(
      worktreePath,
      checkpointCommits,
      signal,
    )
    const revisions = sinceCommit === undefined
      ? ["HEAD", ...checkpointRefs]
      : [`^${sinceCommit}`, "HEAD", ...checkpointRefs]
    await git(worktreePath, ["bundle", "create", resolved, ...revisions], signal)
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
    if (!safeSessionId.test(sessionId)) {
      throw new Error("Session id is not safe for a worktree")
    }
    signal?.throwIfAborted()
    const claimDirectory = join(this.worktreeRoot, ".restore-claims")
    const claimPath = join(claimDirectory, sessionId)
    if (activeBundleRestores.has(claimPath)) throw new SessionWorktreeExistsError()
    activeBundleRestores.add(claimPath)
    let claim: Awaited<ReturnType<typeof open>> | undefined
    let outcome: { completed: true; workspace: SessionWorkspace } | { completed: false; error: unknown }
    const cleanupErrors: unknown[] = []
    try {
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
      signal?.throwIfAborted()
      outcome = { completed: true, workspace: await this.#restoreClaimedSessionFromBundle(bundlePath, sessionId, options, signal) }
    } catch (error) {
      outcome = { completed: false, error }
    } finally {
      try {
        if (claim) {
          // A close failure must not skip unlink. Neither cleanup failure may
          // hide the restore outcome or keep the process reservation occupied.
          try { await claim.close() } catch (error) { cleanupErrors.push(error) }
          try { await unlink(claimPath) } catch (error) { cleanupErrors.push(error) }
        }
      } finally {
        activeBundleRestores.delete(claimPath)
      }
    }
    if (cleanupErrors.length > 0) {
      // Preserve even frozen or non-Error failures without mutating them.
      throw new SessionRestoreClaimCleanupError(claimPath, cleanupErrors, outcome.completed ? undefined : outcome)
    }
    if (!outcome.completed) throw outcome.error
    return outcome.workspace
  }

  async #restoreClaimedSessionFromBundle(
    bundlePath: string,
    sessionId: string,
    options: SessionBundleRestoreOptions,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
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
    try {
      await git(repository.root, [
        "fetch",
        "--quiet",
        "--atomic",
        "--",
        bundlePath,
        `+HEAD:${incomingRef}`,
        ...incomingCheckpoints.map(({ source, target }) => `+${source}:${target}`),
      ], signal)
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
        const [status, worktreeCommon, repositoryCommon] = await Promise.all([
          git(path, ["status", "--porcelain"], signal),
          git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
          git(repository.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
        ])
        if (
          status.length > 0
          || await realpath(worktreeCommon) !== await realpath(repositoryCommon)
        ) {
          throw new SessionWorktreeExistsError()
        }
        await git(path, ["checkout", "--quiet", "-B", branch, arrived], signal)
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
        await git(repository.root, ["worktree", "add", "-b", branch, path, arrived], signal)
      } catch (error) {
        // A concurrent restore can win either the branch or path. The loser
        // must never clean up the winner's worktree.
        const detail = error instanceof Error ? error.message : ""
        if (/already exists|already checked out/u.test(detail)) {
          throw new SessionWorktreeExistsError()
        }
        throw error
      }
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
    const recovery = await this.checkpoint(worktreePath, "before restore", signal)
    await git(worktreePath, ["reset", "--hard", checkpointCommit], signal)
    return { restoredCommit: checkpointCommit, recoveryCommit: recovery.commit }
  }

  // Reverting one file discards uncommitted work, so the recovery checkpoint is
  // taken before anything in the worktree moves, and every step after it either
  // completes or throws. The checkpoint commits the whole worktree, so HEAD is
  // put back where it was afterwards and only the named file is changed.
  async revertFile(
    worktreePath: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileRevert> {
    if (!isWorktreeRelativePath(path)) {
      throw new Error("File path must stay inside the session worktree")
    }
    const pathspec = `:(literal)${path}`
    const baseCommit = await git(worktreePath, ["rev-parse", "HEAD"], signal)
    const status = await git(worktreePath, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--",
      pathspec,
    ], signal)
    if (status.length === 0) throw new Error("File has no changes to revert")

    let tracked = true
    try {
      await git(worktreePath, ["cat-file", "-e", `${baseCommit}:${path}`], signal)
    } catch {
      signal?.throwIfAborted()
      tracked = false
    }

    const recovery = await this.checkpoint(worktreePath, `before revert ${path}`, signal)
    // The checkpoint moved HEAD onto the work being reverted. Putting HEAD back
    // keeps the session where it was, and leaves the recovery commit reachable
    // only through its durable checkpoint ref.
    try {
      await git(worktreePath, ["reset", "--soft", baseCommit], signal)
      if (tracked) {
        await git(worktreePath, ["checkout", baseCommit, "--", pathspec], signal)
      } else {
        await git(worktreePath, ["rm", "--force", "--quiet", "--", pathspec], signal)
      }
    } catch (cause) {
      throw new FileRevertIncompleteError(recovery.commit, { cause })
    }
    return {
      path,
      outcome: tracked ? "restored" : "removed",
      baseCommit,
      recoveryCommit: recovery.commit,
    }
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
