import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, realpath, rename, rm } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const safeSessionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const safeRemoteName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

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

export class SessionWorktreeExistsError extends Error {
  constructor() {
    super("Session worktree already exists")
    this.name = "SessionWorktreeExistsError"
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
  ): Promise<SessionBundle>
  restoreSessionFromBundle?(
    bundlePath: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace>
  pushSessionRef?(
    worktreePath: string,
    remote: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionRef>
  sessionHeadCommit?(sessionId: string, signal?: AbortSignal): Promise<string | undefined>
  restoreSessionFromRef?(
    repositoryPath: string,
    remote: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace>
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

async function restrictBundlePermissions(path: string): Promise<void> {
  // A bundle holds every byte of the session worktree, so it is readable only
  // by the account that made it.
  if (process.platform === "win32") return
  await chmod(path, 0o600)
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
    signal,
  })
  return result.stdout.trim()
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
): Promise<string> {
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
  return createHash("sha256")
    .update(baseCommit)
    .update("\0")
    .update(status)
    .update("\0")
    .update(diffHash)
    .digest("hex")
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

  constructor(worktreeRoot: string, options: GitWorkspaceServiceOptions = {}) {
    this.worktreeRoot = resolve(worktreeRoot)
    this.#afterEvidenceObservation = options.afterEvidenceObservation
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
      if (fingerprintBefore !== fingerprintAfter) continue

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

  async checkpoint(worktreePath: string, label: string, signal?: AbortSignal): Promise<Checkpoint> {
    await git(worktreePath, ["add", "--all"], signal)
    const names = await git(worktreePath, ["diff", "--cached", "--name-only", "-z"], signal)
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
    await git(worktreePath, ["push", "--", remote, `${commit}:${ref}`], signal)
    return { ref, commit, remote }
  }

  // The target side of the opt-in path: the session arrives through the remote
  // both machines already share, not as bytes over the daemon connection.
  async restoreSessionFromRef(
    repositoryPath: string,
    remote: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    if (!safeSessionId.test(sessionId)) throw new Error("Session id is not safe for a worktree")
    if (!safeRemoteName.test(remote)) throw new Error("Remote name is not safe")

    const ref = `refs/domovoi/sessions/${sessionId}`
    await git(repositoryPath, ["fetch", "--quiet", "--", remote, `${ref}:${ref}`], signal)
    const commit = await git(repositoryPath, ["rev-parse", `${ref}^{commit}`], signal)

    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    await mkdir(this.worktreeRoot, { recursive: true })
    try {
      await realpath(path)
      throw new SessionWorktreeExistsError()
    } catch (error) {
      if (error instanceof SessionWorktreeExistsError) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    await git(repositoryPath, ["worktree", "add", "-b", branch, path, commit], signal)
    // The transferred checkpoint stays restorable here, as it does when a
    // session arrives as a bundle.
    await git(path, ["update-ref", `refs/domovoi/checkpoints/${commit}`, commit], signal)
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

    const range = sinceCommit === undefined ? "HEAD" : `${sinceCommit}..HEAD`
    await git(worktreePath, ["bundle", "create", resolved, range], signal)
    await restrictBundlePermissions(resolved)
    return { path: resolved, commit, incremental: sinceCommit !== undefined }
  }

  // The target rebuilds the session from bundle bytes alone, so a transfer
  // never needs the source repository or a shared remote.
  async restoreSessionFromBundle(
    bundlePath: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace> {
    if (!safeSessionId.test(sessionId)) {
      throw new Error("Session id is not safe for a worktree")
    }

    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    await mkdir(this.worktreeRoot, { recursive: true })

    // A session this machine already holds takes the bundle as a fetch: an
    // incremental bundle has no history to clone from, and the worktree that
    // is already here is the thing being brought forward.
    const held = await this.sessionHeadCommit(sessionId, signal)
    if (held !== undefined) {
      // Work that is here and not committed is not this transfer's to discard,
      // so a session with changes in it is refused rather than brought forward.
      const status = await git(path, ["status", "--porcelain"], signal)
      if (status.length > 0) throw new SessionWorktreeExistsError()
      try {
        await git(path, ["fetch", "--quiet", "--", bundlePath, `+HEAD:refs/domovoi/incoming/${sessionId}`], signal)
      } catch {
        signal?.throwIfAborted()
        throw new Error("Bundle could not be verified")
      }
      const arrived = await git(path, ["rev-parse", `refs/domovoi/incoming/${sessionId}`], signal)
      await git(path, ["checkout", "--quiet", "-B", branch, arrived], signal)
      await git(path, ["update-ref", `refs/domovoi/checkpoints/${arrived}`, arrived], signal)
      await git(path, ["update-ref", "-d", `refs/domovoi/incoming/${sessionId}`], signal)
      return { path, branch, baseCommit: arrived }
    }

    // The clone happens somewhere this restore owns outright, so nothing it
    // cleans up can belong to another restore or to an existing session. The
    // finished worktree is then claimed with a rename, which the filesystem
    // settles between concurrent restores: only one can win.
    const staging = join(this.worktreeRoot, `.incoming-${sessionId}-${randomUUID()}`)
    try {
      await gitDirectory(this.worktreeRoot, ["clone", "--quiet", bundlePath, staging], signal)
    } catch {
      signal?.throwIfAborted()
      // The bundle is the only thing the target trusts here, so anything it
      // cannot read is refused rather than partly applied.
      await rm(staging, { recursive: true, force: true })
      throw new Error("Bundle could not be verified")
    }

    try {
      await git(staging, ["checkout", "--quiet", "-B", branch], signal)
      const staged = await git(staging, ["rev-parse", "HEAD"], signal)
      // The transferred checkpoint has to stay restorable on this machine,
      // which means carrying the durable ref, not only the commit.
      await git(staging, ["update-ref", `refs/domovoi/checkpoints/${staged}`, staged], signal)
      await rename(staging, path)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EACCES") {
        throw new SessionWorktreeExistsError()
      }
      throw error
    }

    const head = await git(path, ["rev-parse", "HEAD"], signal)
    return { path, branch, baseCommit: head }
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
