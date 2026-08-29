import { execFile, spawn } from "node:child_process"
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

export interface WorkspaceService {
  inspect(repositoryPath: string, signal?: AbortSignal): Promise<RepositoryInfo>
  createSessionWorkspace(
    repositoryPath: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionWorkspace>
  removeSessionWorkspace(worktreePath: string, signal?: AbortSignal): Promise<void>
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

  constructor(worktreeRoot: string) {
    this.worktreeRoot = resolve(worktreeRoot)
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

  async evidence(worktreePath: string, signal?: AbortSignal): Promise<WorkspaceEvidence> {
    const [baseCommit, status, numstat, diff] = await Promise.all([
      git(worktreePath, ["rev-parse", "HEAD"], signal),
      git(worktreePath, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], signal),
      git(worktreePath, [
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
        ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--"],
        maximumEvidenceDiffBytes,
        signal,
      ),
    ])
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
    const branch = await git(path, ["branch", "--show-current"], signal)
    const commonDirectory = await git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ], signal)
    await gitDirectory(commonDirectory, ["worktree", "remove", "--force", path], signal)
    if (branch.startsWith("domovoi/")) {
      await gitDirectory(commonDirectory, ["branch", "-D", branch], signal)
    }
  }
}
