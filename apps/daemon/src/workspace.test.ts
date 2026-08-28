import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
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
    expect(resolve(await realpath(repository.root))).toBe(resolve(await realpath(repositoryPath)))
    expect(repository).toMatchObject({ name: "project", branch: "main" })

    const workspace = await service.createSessionWorkspace(repositoryPath, "session-1")
    expect(workspace).toMatchObject({ branch: "domovoi/session-1" })
    expect(relative(worktreeRoot, workspace.path)).toBe("session-1")
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

    await writeFile(join(workspace.path, "README.md"), "after checkpoint\n")
    await writeFile(join(workspace.path, "temporary.txt"), "recover me\n")
    const restored = await service.restore(workspace.path, checkpoint.commit)
    expect(restored).toMatchObject({ restoredCommit: checkpoint.commit })
    expect(restored.recoveryCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(
      (await readFile(join(workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n"),
    ).toBe("after\n")
    await expect(readFile(join(workspace.path, "temporary.txt"), "utf8")).rejects.toThrow()

    await service.restore(workspace.path, restored.recoveryCommit)
    expect(
      (await readFile(join(workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n"),
    ).toBe("after checkpoint\n")
    expect(
      (await readFile(join(workspace.path, "temporary.txt"), "utf8")).replaceAll("\r\n", "\n"),
    ).toBe("recover me\n")

    await writeFile(join(workspace.path, "README.md"), "must not commit\n")
    const headBeforeAbort = await execute("git", ["-C", workspace.path, "rev-parse", "HEAD"])
    await expect(service.checkpoint(
      workspace.path,
      "aborted",
      AbortSignal.abort(new Error("request timed out")),
    )).rejects.toThrow()
    const headAfterAbort = await execute("git", ["-C", workspace.path, "rev-parse", "HEAD"])
    expect(headAfterAbort.stdout).toBe(headBeforeAbort.stdout)

    await service.removeSessionWorkspace(workspace.path)
    await expect(readFile(join(workspace.path, "README.md"), "utf8")).rejects.toThrow()
    const worktrees = await execute("git", ["-C", repositoryPath, "worktree", "list", "--porcelain"])
    expect(worktrees.stdout).not.toContain(workspace.path)
    const branches = await execute("git", ["-C", repositoryPath, "branch", "--list", workspace.branch])
    expect(branches.stdout).toBe("")
    await expect(service.removeSessionWorkspace(workspace.path)).resolves.toBeUndefined()
  })

  it("rejects session identifiers that could escape the worktree root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const service = new GitWorkspaceService(join(scratch, "worktrees"))

    await expect(service.createSessionWorkspace(scratch, "../escape")).rejects.toThrow(
      "Session id is not safe for a worktree",
    )
  })

  it("rejects commits that are not Domovoi checkpoints", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
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
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-1")

    await expect(service.restore(workspace.path, workspace.baseCommit)).rejects.toThrow(
      "Commit is not a Domovoi checkpoint",
    )
    await expect(service.restore(workspace.path, "not-a-commit")).rejects.toThrow(
      "Checkpoint commit is invalid",
    )
  })
})
