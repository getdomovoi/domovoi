import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
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

  it("reads changed-file and diff evidence from the Git worktree", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await mkdir(join(repositoryPath, "src"))
    await writeFile(join(repositoryPath, "README.md"), "before\n")
    await writeFile(join(repositoryPath, "binary.dat"), Buffer.from([0, 1, 2]))
    await writeFile(join(repositoryPath, "src", "old.ts"), "export const old = true\n")
    await writeFile(join(repositoryPath, "remove.txt"), "remove me\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
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
    const baseCommit = (await execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"]))
      .stdout.trim()

    await writeFile(join(repositoryPath, "README.md"), "staged\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await writeFile(join(repositoryPath, "README.md"), "unstaged too\n")
    await writeFile(join(repositoryPath, "binary.dat"), Buffer.from([0, 1, 3]))
    await execute("git", ["-C", repositoryPath, "mv", "src/old.ts", "src/new name.ts"])
    await rm(join(repositoryPath, "remove.txt"))
    await writeFile(join(repositoryPath, "untracked file.ts"), "export const fresh = true\n")

    const evidence = await new GitWorkspaceService(join(scratch, "worktrees"))
      .evidence(repositoryPath)

    expect(evidence).toMatchObject({
      baseCommit,
      totalChangedFiles: 5,
      filesTruncated: false,
      diffTruncated: false,
    })
    expect(evidence.files).toEqual([
      expect.objectContaining({
        path: "binary.dat",
        status: "modified",
        binary: true,
        additions: null,
        deletions: null,
      }),
      expect.objectContaining({
        path: "README.md",
        status: "modified",
        staged: true,
        unstaged: true,
        binary: false,
      }),
      expect.objectContaining({
        path: "remove.txt",
        status: "deleted",
        staged: false,
        unstaged: true,
      }),
      expect.objectContaining({
        path: "src/new name.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        staged: true,
        unstaged: false,
      }),
      expect.objectContaining({
        path: "untracked file.ts",
        status: "untracked",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
      }),
    ])
    expect(evidence.diff).toContain("diff --git a/README.md b/README.md")
    expect(evidence.diff).toContain("unstaged too")
    expect(evidence.diff).not.toContain("untracked file.ts")
  })

  it("bounds Git evidence without changing its measured totals", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, "tracked.txt"), "before\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
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
    await writeFile(join(repositoryPath, "tracked.txt"), `${"changed\n".repeat(40_000)}`)
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      writeFile(join(repositoryPath, `untracked-${String(index).padStart(3, "0")}.txt`), "new\n")
    ))

    const evidence = await new GitWorkspaceService(join(scratch, "worktrees"))
      .evidence(repositoryPath)

    expect(evidence.totalChangedFiles).toBe(206)
    expect(evidence.files).toHaveLength(200)
    expect(evidence.filesTruncated).toBe(true)
    expect(evidence.diffTruncated).toBe(true)
    expect(Buffer.byteLength(evidence.diff, "utf8")).toBeLessThanOrEqual(256 * 1_024)
  })

  it("does not execute repository-configured text conversion commands", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, ".gitattributes"), "*.secret diff=observe\n")
    await writeFile(join(repositoryPath, "value.secret"), "before\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
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
    await execute("git", [
      "-C",
      repositoryPath,
      "config",
      "diff.observe.textconv",
      "domovoi-textconv-must-not-run",
    ])
    await writeFile(join(repositoryPath, "value.secret"), "after\n")

    await expect(new GitWorkspaceService(join(scratch, "worktrees")).evidence(repositoryPath))
      .resolves.toMatchObject({ totalChangedFiles: 1 })
  })
})
