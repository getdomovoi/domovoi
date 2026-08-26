import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { GitWorkspaceService } from "./workspace.js"

const execute = promisify(execFile)
const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("GitWorkspaceService", () => {
  it("creates an isolated session worktree and checkpoint", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, "README.md"), "before\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C",
      repositoryPath,
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ])

    const service = new GitWorkspaceService(worktreeRoot)
    const repository = await service.inspect(repositoryPath)
    expect(repository).toMatchObject({ root: repositoryPath, name: "project", branch: "main" })

    const workspace = await service.createSessionWorkspace(repositoryPath, "session-1")
    expect(workspace).toMatchObject({ branch: "domovoi/session-1" })
    expect(workspace.path.startsWith(`${worktreeRoot}/`)).toBe(true)
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const checkpoint = await service.checkpoint(workspace.path, "before-agent-turn")
    expect(checkpoint.changedFiles).toEqual(["README.md"])
    expect(checkpoint.commit).toMatch(/^[a-f0-9]{40}$/)
    await expect(readFile(join(repositoryPath, "README.md"), "utf8")).resolves.toBe("before\n")

    const branchContents = await execute("git", [
      "-C",
      repositoryPath,
      "show",
      "domovoi/session-1:README.md",
    ])
    expect(branchContents.stdout).toBe("after\n")
  })

  it("rejects session identifiers that could escape the worktree root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const service = new GitWorkspaceService(join(scratch, "worktrees"))

    await expect(service.createSessionWorkspace(scratch, "../escape")).rejects.toThrow(
      "Session id is not safe for a worktree",
    )
  })
})
