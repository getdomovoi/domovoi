import { execFile } from "node:child_process"
import { mkdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
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

export interface WorkspaceService {
  inspect(repositoryPath: string): Promise<RepositoryInfo>
  createSessionWorkspace(repositoryPath: string, sessionId: string): Promise<SessionWorkspace>
  removeSessionWorkspace(worktreePath: string): Promise<void>
  checkpoint(worktreePath: string, label: string): Promise<Checkpoint>
}

async function git(repositoryPath: string, arguments_: string[]): Promise<string> {
  const result = await execute("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
  })
  return result.stdout.trim()
}

export class GitWorkspaceService implements WorkspaceService {
  readonly worktreeRoot: string

  constructor(worktreeRoot: string) {
    this.worktreeRoot = resolve(worktreeRoot)
  }

  async inspect(repositoryPath: string): Promise<RepositoryInfo> {
    const root = await git(repositoryPath, ["rev-parse", "--show-toplevel"])
    const [branch, head] = await Promise.all([
      git(root, ["branch", "--show-current"]),
      git(root, ["rev-parse", "HEAD"]),
    ])
    return { root, name: basename(root), branch, head }
  }

  async createSessionWorkspace(
    repositoryPath: string,
    sessionId: string,
  ): Promise<SessionWorkspace> {
    if (!safeSessionId.test(sessionId)) {
      throw new Error("Session id is not safe for a worktree")
    }
    const repository = await this.inspect(repositoryPath)
    const path = join(this.worktreeRoot, sessionId)
    const branch = `domovoi/${sessionId}`
    await mkdir(this.worktreeRoot, { recursive: true })
    await git(repository.root, ["worktree", "add", "-b", branch, path, repository.head])
    return { path, branch, baseCommit: repository.head }
  }

  async checkpoint(worktreePath: string, label: string): Promise<Checkpoint> {
    await git(worktreePath, ["add", "--all"])
    const names = await git(worktreePath, ["diff", "--cached", "--name-only", "-z"])
    const changedFiles = names.split("\0").filter(Boolean)
    if (changedFiles.length === 0) {
      return { commit: await git(worktreePath, ["rev-parse", "HEAD"]), changedFiles }
    }

    await git(worktreePath, [
      "-c",
      "user.name=Domovoi",
      "-c",
      "user.email=domovoi@localhost",
      "commit",
      "-m",
      `chore(domovoi): checkpoint ${label}`,
    ])
    return {
      commit: await git(worktreePath, ["rev-parse", "HEAD"]),
      changedFiles,
    }
  }

  async removeSessionWorkspace(worktreePath: string): Promise<void> {
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
    const repositoryRoot = await git(path, ["rev-parse", "--show-toplevel"])
    if (await realpath(repositoryRoot) !== path) {
      throw new Error("Worktree path does not identify a Git worktree root")
    }
    const branch = await git(path, ["branch", "--show-current"])
    const commonDirectory = await git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
    await git(path, ["worktree", "remove", "--force", path])
    if (branch.startsWith("domovoi/")) {
      await git(dirname(commonDirectory), ["branch", "-D", branch])
    }
  }
}
