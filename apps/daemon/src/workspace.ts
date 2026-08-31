import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const safeSessionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

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
  evidence?(worktreePath: string, signal?: AbortSignal): Promise<WorkspaceEvidence>
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
