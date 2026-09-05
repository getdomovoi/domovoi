import { execFile } from "node:child_process"
import { removeScratchDirectories } from "./test-scratch.js"
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { GitWorkspaceService, utf8GitPaths, WorkspaceEvidenceUnstableError } from "./workspace.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) }
})

const execute = promisify(execFile)
const scratchDirectories: string[] = []

async function failNextRestoreClaimClose(error: Error) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close()
      throw error
    })
    return handle
  })
}

afterEach(async () => {
  vi.mocked(open).mockReset()
  vi.mocked(unlink).mockReset()
  await removeScratchDirectories(scratchDirectories.splice(0))
})

describe("GitWorkspaceService", () => {
  it("archives only the session worktree while retaining its branch and source checkout", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-archive-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "source\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", ["-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"])

    const service = new GitWorkspaceService(worktreeRoot)
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-archive")
    await writeFile(join(workspace.path, "README.md"), "archived work\n")
    const checkpoint = await service.checkpoint(workspace.path, "before archive")
    const sourceBefore = await Promise.all([
      execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"]),
      execute("git", ["-C", repositoryPath, "branch", "--show-current"]),
      execute("git", ["-C", repositoryPath, "status", "--porcelain"]),
      readFile(join(repositoryPath, "README.md"), "utf8"),
    ])

    await service.archiveSessionWorkspace(workspace.path)
    await service.archiveSessionWorkspace(workspace.path)

    await expect(readFile(join(workspace.path, "README.md"), "utf8")).rejects.toThrow()
    expect((await execute("git", ["-C", repositoryPath, "branch", "--list", workspace.branch])).stdout).toContain(workspace.branch)
    expect((await execute("git", ["-C", repositoryPath, "rev-parse", `refs/domovoi/checkpoints/${checkpoint.commit}`])).stdout.trim()).toBe(checkpoint.commit)
    const sourceAfter = await Promise.all([
      execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"]),
      execute("git", ["-C", repositoryPath, "branch", "--show-current"]),
      execute("git", ["-C", repositoryPath, "status", "--porcelain"]),
      readFile(join(repositoryPath, "README.md"), "utf8"),
    ])
    expect(sourceAfter.map((value) => typeof value === "string" ? value : value.stdout)).toEqual(
      sourceBefore.map((value) => typeof value === "string" ? value : value.stdout),
    )
  })

  it("creates an isolated session worktree and checkpoint", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
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

  it("forks an idempotent isolated worktree from a durable checkpoint", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-fork-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const canonicalWorktreeRoot = join(scratch, "canonical-worktrees")
    const worktreeRoot = join(scratch, "worktrees-alias")
    await mkdir(canonicalWorktreeRoot)
    await symlink(canonicalWorktreeRoot, worktreeRoot, process.platform === "win32" ? "junction" : "dir")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "source\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", ["-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"])

    const service = new GitWorkspaceService(worktreeRoot)
    const source = await service.createSessionWorkspace(repositoryPath, "session-source")
    await writeFile(join(source.path, "README.md"), "checkpoint state\n")
    const checkpoint = await service.checkpoint(source.path, "fork point")
    await writeFile(join(source.path, "README.md"), "source continues\n")
    const sourceBefore = await Promise.all([
      execute("git", ["-C", source.path, "rev-parse", "HEAD"]),
      execute("git", ["-C", source.path, "branch", "--show-current"]),
      execute("git", ["-C", source.path, "status", "--porcelain"]),
      readFile(join(source.path, "README.md"), "utf8"),
    ])

    const fork = await service.createSessionWorkspaceFromCheckpoint(source.path, checkpoint.commit, "session-fork-request")
    const retry = await service.createSessionWorkspaceFromCheckpoint(source.path, checkpoint.commit, "session-fork-request")

    expect(fork.path).toBe(await realpath(fork.path))
    expect(retry).toEqual(fork)
    expect(fork).toMatchObject({ branch: "domovoi/session-fork-request", baseCommit: checkpoint.commit })
    await expect(readFile(join(fork.path, "README.md"), "utf8")).resolves.toMatch(/^checkpoint state\r?\n$/)
    const sourceAfter = await Promise.all([
      execute("git", ["-C", source.path, "rev-parse", "HEAD"]),
      execute("git", ["-C", source.path, "branch", "--show-current"]),
      execute("git", ["-C", source.path, "status", "--porcelain"]),
      readFile(join(source.path, "README.md"), "utf8"),
    ])
    expect(sourceAfter.map((value) => typeof value === "string" ? value : value.stdout)).toEqual(
      sourceBefore.map((value) => typeof value === "string" ? value : value.stdout),
    )

    await writeFile(join(fork.path, "fork-only.txt"), "advance fork\n")
    await execute("git", ["-C", fork.path, "add", "fork-only.txt"])
    await execute("git", ["-C", fork.path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "advance fork"])
    await expect(service.createSessionWorkspaceFromCheckpoint(
      source.path,
      checkpoint.commit,
      "session-fork-request",
    )).rejects.toThrow("conflicts with an existing session worktree")
    await execute("git", ["-C", fork.path, "reset", "--hard", checkpoint.commit])
    await execute("git", ["-C", fork.path, "checkout", "-b", "wrong-fork-branch"])
    await expect(service.createSessionWorkspaceFromCheckpoint(
      source.path,
      checkpoint.commit,
      "session-fork-request",
    )).rejects.toThrow("conflicts with an existing session worktree")

    await execute("git", ["-C", repositoryPath, "worktree", "remove", "--force", fork.path])
    await execute("git", ["-C", source.path, "add", "README.md"])
    await execute("git", ["-C", source.path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "advance source"])
    await execute("git", ["-C", source.path, "branch", "-f", fork.branch, "HEAD"])
    await expect(service.createSessionWorkspaceFromCheckpoint(
      source.path,
      checkpoint.commit,
      "session-fork-request",
    )).rejects.toThrow("conflicts with an existing session branch")
    await execute("git", ["-C", source.path, "branch", "-f", fork.branch, checkpoint.commit])
    const reattached = await service.createSessionWorkspaceFromCheckpoint(
      source.path,
      checkpoint.commit,
      "session-fork-request",
    )
    expect(reattached).toEqual(fork)
    await expect(readFile(join(reattached.path, "README.md"), "utf8")).resolves.toMatch(/^checkpoint state\r?\n$/)
    await expect(service.createSessionWorkspaceFromCheckpoint(
      source.path,
      "f".repeat(40),
      "session-missing-checkpoint",
    )).rejects.toThrow("Commit is not a Domovoi checkpoint")
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
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
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
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
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

  it("retries when the worktree changes between Git evidence observations", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-evidence-generation-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "alpha.txt"), "alpha base\n")
    await writeFile(join(repositoryPath, "beta.txt"), "beta base\n")
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
    await writeFile(join(repositoryPath, "alpha.txt"), "alpha changed\n")
    let observations = 0
    const service = new GitWorkspaceService(join(scratch, "worktrees"), {
      afterEvidenceObservation: async (observation) => {
        if (observation !== "status" || observations++ > 0) return
        await writeFile(join(repositoryPath, "alpha.txt"), "alpha base\n")
        await writeFile(join(repositoryPath, "beta.txt"), "beta changed\n")
      },
    })

    const evidence = await service.evidence(repositoryPath)

    expect({
      files: evidence.files.map((file) => file.path),
      includesAlphaDiff: evidence.diff.includes("diff --git a/alpha.txt b/alpha.txt"),
      includesBetaDiff: evidence.diff.includes("diff --git a/beta.txt b/beta.txt"),
    }).toEqual({
      files: ["beta.txt"],
      includesAlphaDiff: false,
      includesBetaDiff: true,
    })
    expect(observations).toBe(2)
  })

  it("fails explicitly after bounded retries against an unstable worktree", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-evidence-unstable-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "alpha.txt"), "alpha base\n")
    await writeFile(join(repositoryPath, "beta.txt"), "beta base\n")
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
    await writeFile(join(repositoryPath, "alpha.txt"), "alpha changed\n")
    let observations = 0
    const service = new GitWorkspaceService(join(scratch, "worktrees"), {
      afterEvidenceObservation: async (observation) => {
        if (observation !== "status") return
        observations += 1
        const odd = observations % 2 === 1
        await writeFile(join(repositoryPath, "alpha.txt"), odd ? "alpha base\n" : "alpha changed\n")
        await writeFile(join(repositoryPath, "beta.txt"), odd ? "beta changed\n" : "beta base\n")
      },
    })

    await expect(service.evidence(repositoryPath)).rejects.toThrow(WorkspaceEvidenceUnstableError)
    expect(observations).toBe(3)
  })

  it("bounds Git evidence without changing its measured totals", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
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
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
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

  it("does not execute a repository-configured file-system monitor", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "before\n")
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
    const markerPath = join(scratch, "fsmonitor-ran")
    const fsmonitorCommand = [
      `"${process.execPath.replaceAll("\\", "/")}"`,
      "-e",
      `"require('node:fs').writeFileSync('${markerPath.replaceAll("\\", "/")}','ran')"`,
    ].join(" ")
    await execute("git", [
      "-C",
      repositoryPath,
      "config",
      "core.fsmonitor",
      fsmonitorCommand,
    ])
    await writeFile(join(repositoryPath, "README.md"), "after\n")

    await expect(new GitWorkspaceService(join(scratch, "worktrees")).evidence(repositoryPath))
      .resolves.toMatchObject({ totalChangedFiles: 1 })
    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  it("reads evidence and checkpoints a worktree whose status exceeds Node's default output buffer", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-large-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, "README.md"), "before\n")
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
    const names = Array.from(
      { length: 7_200 },
      (_, index) => `untracked-${String(index).padStart(5, "0")}-${"x".repeat(144)}`,
    )
    const statusBytes = names.reduce((total, name) => total + Buffer.byteLength(`? ${name}\0`), 0)
    expect(statusBytes).toBeGreaterThan(1_024 * 1_024)
    for (let start = 0; start < names.length; start += 500) {
      await Promise.all(
        names.slice(start, start + 500).map((name) => writeFile(join(repositoryPath, name), "")),
      )
    }

    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    await expect(service.evidence(repositoryPath)).resolves.toMatchObject({
      totalChangedFiles: names.length,
      filesTruncated: true,
    })
    const checkpoint = await service.checkpoint(repositoryPath, "large")
    expect(checkpoint.changedFiles).toHaveLength(names.length)
    expect((await execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(checkpoint.commit)
  })

  it("restores the index when a checkpoint fails after staging", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-checkpoint-rollback-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, "tracked.txt"), "base\n")
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
    await writeFile(join(repositoryPath, "tracked.txt"), "changed\n")
    await rm(join(repositoryPath, "remove.txt"))
    await writeFile(join(repositoryPath, "fresh.txt"), "fresh\n")
    const observe = async () => ({
      head: (await execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim(),
      staged: (await execute("git", ["-C", repositoryPath, "diff", "--cached", "--name-only"])).stdout,
      status: (await execute("git", ["-C", repositoryPath, "status", "--porcelain"])).stdout,
      tracked: await readFile(join(repositoryPath, "tracked.txt"), "utf8"),
      fresh: await readFile(join(repositoryPath, "fresh.txt"), "utf8"),
    })
    const before = await observe()
    expect(before.staged).toBe("")

    const controller = new AbortController()
    const service = new GitWorkspaceService(join(scratch, "worktrees"), {
      afterCheckpointStaging: () => controller.abort(new Error("checkpoint timed out")),
    })
    await expect(service.checkpoint(repositoryPath, "interrupted", controller.signal))
      .rejects.toThrow("checkpoint timed out")

    expect(await observe()).toEqual(before)
  })
})

describe("GitWorkspaceService session bundles", () => {
  async function repositoryWithSession(prefix: string) {
    const scratch = await mkdtemp(join(tmpdir(), prefix))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const base = (await execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim()
    const service = new GitWorkspaceService(worktreeRoot)
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-1")
    return { scratch, service, workspace, base }
  }

  it("bundles the session checkpoint so a target can restore it", async () => {
    const { scratch, service, workspace } = await repositoryWithSession("domovoi-bundle-")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await service.checkpoint(workspace.path, "before-transfer")

    const bundle = await service.bundleSession(workspace.path, join(scratch, "session.bundle"))

    expect(bundle.commit).toBe(checkpoint.commit)
    const listed = await execute("git", ["bundle", "list-heads", bundle.path])
    expect(listed.stdout).toContain(checkpoint.commit)
  })

  it("carries only what the target does not already have", async () => {
    const { scratch, service, workspace, base } = await repositoryWithSession("domovoi-bundle-since-")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    await service.checkpoint(workspace.path, "before-transfer")

    const incremental = await service.bundleSession(
      workspace.path,
      join(scratch, "incremental.bundle"),
      base,
    )

    // A bundle that starts at a commit the target holds cannot be verified
    // against a repository that lacks it.
    const empty = join(scratch, "empty")
    await execute("git", ["init", "--initial-branch=main", empty])
    await expect(execute("git", ["-C", empty, "bundle", "verify", incremental.path]))
      .rejects.toThrow()
  })

  it("refuses to bundle a worktree whose work is not checkpointed", async () => {
    const { scratch, service, workspace } = await repositoryWithSession("domovoi-bundle-dirty-")
    await service.checkpoint(workspace.path, "before-transfer")
    // Work done after the checkpoint would not travel in the bundle.
    await writeFile(join(workspace.path, "README.md"), "uncommitted\n")

    await expect(service.bundleSession(workspace.path, join(scratch, "dirty.bundle")))
      .rejects.toThrow("Session worktree has work that is not checkpointed")
  })

  it("refuses to write a bundle outside the directory it was given", async () => {
    const { service, workspace } = await repositoryWithSession("domovoi-bundle-escape-")
    await service.checkpoint(workspace.path, "before-transfer")

    await expect(service.bundleSession(workspace.path, `${workspace.path}/../escape.bundle`))
      .rejects.toThrow("Bundle path must not traverse")
    await expect(service.bundleSession(workspace.path, "relative.bundle"))
      .rejects.toThrow("Bundle path must not traverse")
  })
})

describe("GitWorkspaceService transfer resources", () => {
  async function repositoryWithIgnoredPreview() {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-resources-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, ".gitignore"), "previews/\n")
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-source")
    await mkdir(join(workspace.path, "previews"))
    await writeFile(join(workspace.path, "previews", "preview.html"), "<h1>portable</h1>\n")
    return { scratch, repositoryPath, service, workspace }
  }

  it("fingerprints all worktree bytes that a confirmation is about", async () => {
    const { service, workspace } = await repositoryWithIgnoredPreview()
    const before = await service.transferFingerprint(workspace.path)
    await writeFile(join(workspace.path, "README.md"), "changed\n")
    const after = await service.transferFingerprint(workspace.path)

    expect(before.headCommit).toBe(workspace.baseCommit)
    expect(before.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(after.digest).not.toBe(before.digest)
  })

  it("binds untracked contents and stays stable when those contents are checkpointed", async () => {
    const { service, workspace } = await repositoryWithIgnoredPreview()
    const draftPath = join(workspace.path, "draft.txt")
    await writeFile(draftPath, "first\n")
    const first = await service.transferFingerprint(workspace.path)
    await writeFile(draftPath, "second\n")
    const second = await service.transferFingerprint(workspace.path)

    expect(second.digest).not.toBe(first.digest)
    const checkpoint = await service.checkpoint(workspace.path, "before-transfer")
    const checkpointed = await service.transferFingerprint(workspace.path)
    expect(checkpointed.headCommit).toBe(checkpoint.commit)
    expect(checkpointed.digest).toBe(second.digest)
  })

  it("stays stable when a tracked deletion is checkpointed", async () => {
    const { service, workspace } = await repositoryWithIgnoredPreview()
    await rm(join(workspace.path, "README.md"))
    const before = await service.transferFingerprint(workspace.path)

    const checkpoint = await service.checkpoint(workspace.path, "before-transfer")
    const after = await service.transferFingerprint(workspace.path)

    expect(after.headCommit).toBe(checkpoint.commit)
    expect(after.digest).toBe(before.digest)
  })

  it("refuses Git path-list bytes that are not valid UTF-8", () => {
    expect(() => utf8GitPaths(Buffer.from([0x66, 0x6f, 0x80, 0x00])))
      .toThrow("Git returned a path that is not valid UTF-8")
  })

  it.runIf(process.platform !== "win32" && process.platform !== "darwin")(
    "refuses a transfer fingerprint when Git reports a non-UTF-8 path",
    async () => {
      const { service, workspace } = await repositoryWithIgnoredPreview()
      const invalidPath = Buffer.concat([
        Buffer.from(`${workspace.path}/`, "utf8"),
        Buffer.from([0x66, 0x6f, 0x80]),
      ])
      await writeFile(invalidPath, "untracked\n")

      await expect(service.transferFingerprint(workspace.path))
        .rejects.toThrow("Git returned a path that is not valid UTF-8")
    },
  )

  it("binds the indexed commit of an uninitialized submodule", async () => {
    const { service, workspace } = await repositoryWithIgnoredPreview()
    const submodulePath = "vendor/dependency"
    await mkdir(join(workspace.path, submodulePath), { recursive: true })
    const alternate = (await execute("git", [
      "-C", workspace.path,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit-tree", `${workspace.baseCommit}^{tree}`,
      "-m", "alternate gitlink",
    ])).stdout.trim()
    await execute("git", [
      "-C", workspace.path,
      "update-index", "--add", "--cacheinfo",
      `160000,${workspace.baseCommit},${submodulePath}`,
    ])
    const first = await service.transferFingerprint(workspace.path)

    await execute("git", [
      "-C", workspace.path,
      "update-index", "--cacheinfo",
      `160000,${alternate},${submodulePath}`,
    ])
    const second = await service.transferFingerprint(workspace.path)

    expect(second.digest).not.toBe(first.digest)
  })

  it("checks that the target project contains the shared lineage commit", async () => {
    const { repositoryPath, service, workspace } = await repositoryWithIgnoredPreview()
    await expect(service.projectHasLineage(repositoryPath, workspace.baseCommit)).resolves.toBe(true)
    await expect(service.projectHasLineage(repositoryPath, "0".repeat(40))).resolves.toBe(false)
  })

  it("promotes only ignored artifact sources and never clobbers a target file", async () => {
    const { service, workspace } = await repositoryWithIgnoredPreview()
    const bytes = await service.readIgnoredArtifactSource(
      workspace.path,
      "previews/preview.html",
    )
    expect(Buffer.from(bytes!)).toEqual(Buffer.from("<h1>portable</h1>\n"))
    await expect(service.readIgnoredArtifactSource(workspace.path, "README.md"))
      .resolves.toBeUndefined()
    await expect(service.readIgnoredArtifactSource(workspace.path, "../outside.html"))
      .rejects.toThrow("Artifact path must stay inside the session worktree")
    await rm(join(workspace.path, "previews", "preview.html"))
    await expect(service.readIgnoredArtifactSource(workspace.path, "previews/preview.html"))
      .resolves.toBeUndefined()

    const target = await service.createSessionWorkspace(
      join(workspace.path, "..", "..", "project"),
      "session-target",
    )
    await service.writeTransferredArtifactSource(target.path, "previews/preview.html", bytes!)
    await service.writeTransferredArtifactSource(target.path, "previews/preview.html", bytes!)
    await expect(readFile(join(target.path, "previews", "preview.html"), "utf8"))
      .resolves.toBe("<h1>portable</h1>\n")
    await expect(service.writeTransferredArtifactSource(
      target.path,
      "previews/preview.html",
      Buffer.from("different\n"),
    )).rejects.toThrow("Transferred artifact source conflicts with an existing file")
  })

  it.runIf(process.platform !== "win32")(
    "never follows an ignored artifact path swapped to a machine-local symlink",
    async () => {
      const { scratch, workspace } = await repositoryWithIgnoredPreview()
      const artifactPath = join(workspace.path, "previews", "preview.html")
      const secretPath = join(scratch, "machine-secret.txt")
      await writeFile(secretPath, "machine-only-secret\n")
      const service = new GitWorkspaceService(join(scratch, "worktrees"), {
        afterIgnoredArtifactValidation: async () => {
          await rm(artifactPath)
          await symlink(secretPath, artifactPath)
        },
      })

      await expect(service.readIgnoredArtifactSource(workspace.path, "previews/preview.html"))
        .rejects.toThrow("Artifact source is unavailable for transfer")
    },
  )
})

describe("GitWorkspaceService bundle restore", () => {
  function restoreGate() {
    let release = () => {}
    const promise = new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Restore test gate deadline expired")), 2_000)
      release = () => { clearTimeout(timer); resolvePromise() }
    })
    return { promise, release }
  }

  async function sourceWithBundle(prefix: string) {
    const scratch = await mkdtemp(join(tmpdir(), prefix))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const targetRepositoryPath = join(scratch, "target-project")
    await execute("git", ["clone", "--quiet", repositoryPath, targetRepositoryPath])
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await source.checkpoint(workspace.path, "before-transfer")
    const bundle = await source.bundleSession(workspace.path, join(scratch, "session.bundle"))
    return { scratch, targetRepositoryPath, checkpoint, bundle }
  }

  it("rebuilds the session worktree from a bundle", async () => {
    const { scratch, targetRepositoryPath, checkpoint, bundle } = await sourceWithBundle("domovoi-restore-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    const restored = await target.restoreSessionFromBundle(
      bundle.path,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    )

    expect(restored.baseCommit).toBe(checkpoint.commit)
    expect(restored.branch).toBe("domovoi/session-1")
    // Git checks out with the platform's line endings, so the transferred
    // content is compared rather than its exact bytes.
    const contents = await readFile(join(restored.path, "README.md"), "utf8")
    expect(contents.replace(/\r\n/g, "\n")).toBe("moved\n")
  })

  it("restores a bundle as a managed worktree that can be archived", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-managed-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))
    const restored = await target.restoreSessionFromBundle(
      bundle.path,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    )

    await expect(target.archiveSessionWorkspace(restored.path)).resolves.toBeUndefined()
    await expect(readFile(join(restored.path, "README.md"), "utf8")).rejects.toThrow()
  })

  it("keeps the transferred checkpoint restorable on the target", async () => {
    const { scratch, targetRepositoryPath, checkpoint, bundle } = await sourceWithBundle("domovoi-restore-ref-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    const restored = await target.restoreSessionFromBundle(
      bundle.path,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    )

    // Restoring later asks for the checkpoint by its Domovoi ref, so the
    // transfer has to carry that ref, not only the commit.
    const durable = await execute("git", [
      "-C", restored.path,
      "rev-parse", `refs/domovoi/checkpoints/${checkpoint.commit}^{commit}`,
    ])
    expect(durable.stdout.trim()).toBe(checkpoint.commit)
  })

  it("carries a restorable checkpoint that is not reachable from the current head", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-restore-history-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const targetRepositoryPath = join(scratch, "target-project")
    await execute("git", ["clone", "--quiet", repositoryPath, targetRepositoryPath])
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    const base = workspace.baseCommit

    await writeFile(join(workspace.path, "README.md"), "abandoned branch\n")
    const historical = await source.checkpoint(workspace.path, "historical")
    await execute("git", ["-C", workspace.path, "reset", "--hard", base])
    await writeFile(join(workspace.path, "README.md"), "current branch\n")
    const current = await source.checkpoint(workspace.path, "current")
    const checkpoints = [historical.commit, current.commit]
    const bundle = await source.bundleSession(
      workspace.path,
      join(scratch, "session.bundle"),
      undefined,
      undefined,
      checkpoints,
    )
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))
    const restored = await target.restoreSessionFromBundle(bundle.path, "session-1", {
      repositoryPath: targetRepositoryPath,
      checkpointCommits: checkpoints,
    })

    await expect(target.restore(restored.path, historical.commit)).resolves.toMatchObject({
      restoredCommit: historical.commit,
    })
    await expect(readFile(join(restored.path, "README.md"), "utf8"))
      .resolves.toMatch(/^abandoned branch\r?\n$/u)
  })

  it("never destroys a session worktree that is already there", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-occupied-")
    const targetRoot = join(scratch, "target-worktrees")
    const target = new GitWorkspaceService(targetRoot)
    await target.restoreSessionFromBundle(
      bundle.path,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    )
    const occupied = join(targetRoot, "session-1")
    await writeFile(join(occupied, "uncommitted.txt"), "work in progress\n")

    await expect(target.restoreSessionFromBundle(
      bundle.path,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    ))
      .rejects.toThrow("Session worktree already exists")
    await expect(readFile(join(occupied, "uncommitted.txt"), "utf8"))
      .resolves.toContain("work in progress")
  })

  it("lets only one concurrent restore claim a session", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-race-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    const [first, second] = await Promise.allSettled([
      target.restoreSessionFromBundle(
        bundle.path,
        "session-1",
        { repositoryPath: targetRepositoryPath },
      ),
      target.restoreSessionFromBundle(
        bundle.path,
        "session-1",
        { repositoryPath: targetRepositoryPath },
      ),
    ])

    const outcomes = [first, second].map((settled) => settled.status)
    expect(outcomes.filter((status) => status === "fulfilled")).toHaveLength(1)
    const rejected = [first, second].find((settled) => settled.status === "rejected")
    expect((rejected as PromiseRejectedResult).reason.message)
      .toContain("Session worktree already exists")
    // The winner's worktree is intact, not removed by the loser's cleanup.
    const claimed = join(scratch, "target-worktrees", "session-1")
    const contents = await readFile(join(claimed, "README.md"), "utf8")
    expect(contents.replace(/\r\n/g, "\n")).toBe("moved\n")
  })

  it("rejects an overlapping restore even when its HEAD lookup follows the winner", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-late-head-")
    const root = join(scratch, "target-worktrees")
    const target = new GitWorkspaceService(root)
    const competing = new GitWorkspaceService(root)
    const reachedHead = restoreGate()
    const releaseFirst = restoreGate()
    const firstHead = target.sessionHeadCommit.bind(target)
    const firstLookup = vi.spyOn(target, "sessionHeadCommit").mockImplementation(async (...args) => {
      reachedHead.release()
      await releaseFirst.promise
      return firstHead(...args)
    })
    const first = target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
    const firstSettled = Promise.allSettled([first])
    const secondHead = competing.sessionHeadCommit.bind(competing)
    const secondLookup = vi.spyOn(competing, "sessionHeadCommit").mockImplementation(async (...args) => {
      // Force the reported CI interleaving without relying on Git timing:
      // the competing call sees the clean worktree the winner just created.
      if (args[0] === "session-1") await first
      return secondHead(...args)
    })
    const competingInspect = vi.spyOn(competing, "inspect")
    let second: ReturnType<GitWorkspaceService["restoreSessionFromBundle"]> | undefined
    try {
      await reachedHead.promise
      second = competing.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
      const settled = Promise.allSettled([first, second])
      await expect(competing.restoreSessionFromBundle(bundle.path, "session-2", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-2" })
      releaseFirst.release()
      const results = await settled
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
      expect(results[1]).toMatchObject({ reason: { message: expect.stringContaining("Session worktree already exists") } })
      // Only the independent session may reach repository work.
      expect(competingInspect).toHaveBeenCalledOnce()
      expect(secondLookup).toHaveBeenCalledOnce()
      expect(secondLookup).toHaveBeenCalledWith("session-2", undefined)
      await expect(readFile(join(root, "session-1", "README.md"), "utf8")).resolves.toMatch(/^moved\r?\n$/u)
    } finally {
      reachedHead.release()
      releaseFirst.release()
      await firstSettled
      await second?.catch(() => undefined)
      firstLookup.mockRestore()
      secondLookup.mockRestore()
      competingInspect.mockRestore()
    }
  })

  it("does not remove another process's restore claim or touch its repository", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-other-claim-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    await mkdir(join(root, ".restore-claims"), { recursive: true })
    await writeFile(claimPath, "another process owns this claim\n")
    const target = new GitWorkspaceService(root)
    const inspect = vi.spyOn(target, "inspect")
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
          .rejects.toThrow("Session worktree already exists")
      }
      expect(inspect).not.toHaveBeenCalled()
      await expect(readFile(claimPath, "utf8")).resolves.toBe("another process owns this claim\n")
      await rm(claimPath)
      await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-1" })
      await expect(lstat(claimPath)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      inspect.mockRestore()
    }
  })

  it("reports a completed restore when unlink fails and clears its process reservation", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-unlink-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const cleanupError = Object.assign(new Error("claim unlink denied"), { code: "EACCES" })
    vi.mocked(unlink).mockRejectedValueOnce(cleanupError)

    const failure = await target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({
      name: "SessionRestoreClaimCleanupError", restoreCompleted: true, claimPath,
      message: expect.stringContaining("Session restore completed"), errors: [cleanupError],
    })
    expect((failure as Error).message).toContain(claimPath)
    expect((failure as Error).message).toContain("Do not retry")
    expect(unlink).toHaveBeenCalledWith(claimPath)
    await expect(readFile(join(root, "session-1", "README.md"), "utf8")).resolves.toMatch(/^moved\r?\n$/u)

    // A filesystem collision includes its path; an uncleared process-local
    // reservation would refuse earlier without identifying that file.
    await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
      .rejects.toThrow(claimPath)
    await rm(claimPath)
    await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
      .resolves.toMatchObject({ branch: "domovoi/session-1" })
  })

  it.each(["completed", "failed"])("retains a replacement claim after a %s restore", async (outcome) => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-replaced-claim-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const replacementToken = "11111111-1111-4111-8111-111111111111"
    const restoreError = Object.freeze(new Error("restore stopped after claim replacement"))
    const head = target.sessionHeadCommit.bind(target)
    let originalToken: string | undefined
    const lookup = vi.spyOn(target, "sessionHeadCommit").mockImplementationOnce(async (...args) => {
      originalToken = await readFile(claimPath, "utf8")
      // Model an operator removing a live claim and another process claiming
      // the same path before this owner finishes. No timing race is required.
      await unlink(claimPath)
      await writeFile(claimPath, replacementToken, { flag: "wx", mode: 0o600 })
      if (outcome === "failed") throw restoreError
      return head(...args)
    })
    try {
      const failure = await target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
        .then(() => undefined, (error: unknown) => error)
      await expect(readFile(claimPath, "utf8")).resolves.toBe(replacementToken)
      expect(failure).toMatchObject({
        name: "SessionRestoreClaimCleanupError",
        restoreCompleted: outcome === "completed",
        claimPath,
        message: expect.stringContaining("claim now belongs to another owner"),
      })
      expect((failure as Error).message).toContain(claimPath)
      expect(originalToken).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
      expect(originalToken).not.toBe(replacementToken)
      if (outcome === "completed") {
        expect((failure as Error).message).toContain("Session restore completed")
        expect((failure as Error).message).toContain("Do not retry")
        await expect(readFile(join(root, "session-1", "README.md"), "utf8")).resolves.toMatch(/^moved\r?\n$/u)
      } else {
        expect((failure as Error).cause).toBe(restoreError)
        expect((failure as AggregateError).errors[0]).toBe(restoreError)
        expect((failure as Error).message.startsWith(restoreError.message)).toBe(true)
      }
      // The process reservation is released, but the replacement file keeps
      // another restore out and must not be removed by that loser either.
      await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .rejects.toThrow(claimPath)
      await expect(readFile(claimPath, "utf8")).resolves.toBe(replacementToken)
    } finally { lookup.mockRestore() }
  })

  it("attempts unlink even if closing the restore claim fails", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-close-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const cleanupError = new Error("claim close failed")
    await failNextRestoreClaimClose(cleanupError)

    await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
      .rejects.toMatchObject({ restoreCompleted: true, claimPath, errors: [cleanupError] })
    expect(unlink).toHaveBeenCalledWith(claimPath)
    await expect(lstat(claimPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
      .resolves.toMatchObject({ branch: "domovoi/session-1" })
  })

  it("does not delete an unverified claim when writing its owner token fails", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-token-write-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const writeError = Object.freeze(new Error("claim token write failed"))
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args)
      vi.spyOn(handle, "writeFile").mockRejectedValueOnce(writeError)
      return handle
    })
    const inspect = vi.spyOn(target, "inspect")
    try {
      const failure = await target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
        .then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({
        name: "SessionRestoreClaimCleanupError", restoreCompleted: false, claimPath, cause: writeError,
        message: expect.stringContaining("owner could not be established"),
      })
      expect((failure as AggregateError).errors[0]).toBe(writeError)
      expect(inspect).not.toHaveBeenCalled()
      expect(unlink).not.toHaveBeenCalled()
      await expect(readFile(claimPath, "utf8")).resolves.toBe("")
      await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .rejects.toThrow(claimPath)
    } finally { inspect.mockRestore() }
  })

  it.each(["Error", "undefined"])("keeps a thrown %s primary when claim cleanup also fails", async (kind) => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-both-errors-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const restoreError = kind === "Error" ? Object.freeze(new Error("repository access refused")) : undefined
    const closeError = new Error("claim close failed")
    const cleanupError = new Error("claim unlink denied")
    const inspect = vi.spyOn(target, "inspect").mockRejectedValueOnce(restoreError)
    await failNextRestoreClaimClose(closeError)
    vi.mocked(unlink).mockRejectedValueOnce(cleanupError)
    try {
      const failure = await target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
        .then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({ restoreCompleted: false, claimPath,
        cause: restoreError, errors: [restoreError, closeError, cleanupError],
      })
      expect((failure as Error).message.startsWith(restoreError?.message ?? "Session restore failed")).toBe(true)
      expect((failure as Error).message).toContain(claimPath)
      expect((failure as Error).cause).toBe(restoreError)
      await expect(lstat(join(root, "session-1"))).rejects.toMatchObject({ code: "ENOENT" })
      await rm(claimPath)
      await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-1" })
    } finally { inspect.mockRestore() }
  })

  it("releases a restore claim after cancellation without leaving incoming refs", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-cancelled-")
    const root = join(scratch, "target-worktrees")
    const target = new GitWorkspaceService(root)
    const cancellation = new AbortController()
    const reason = new Error("Restore cancelled by test")
    const lookup = vi.spyOn(target, "sessionHeadCommit").mockImplementationOnce(async () => {
      cancellation.abort(reason)
      return undefined
    })
    try {
      await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }, cancellation.signal))
        .rejects.toBe(reason)
      await expect(lstat(join(root, ".restore-claims", "session-1"))).rejects.toMatchObject({ code: "ENOENT" })
      const incoming = await execute("git", ["-C", targetRepositoryPath, "for-each-ref", "--format=%(refname)", "refs/domovoi/incoming"])
      expect(incoming.stdout.trim()).toBe("")
      await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-1" })
    } finally {
      lookup.mockRestore()
    }
  })

  it("releases its claim when cancelled immediately after exclusive open", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-cancel-open-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const cancellation = new AbortController()
    const reason = new Error("cancelled immediately after claim acquisition")
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args)
      cancellation.abort(reason)
      return handle
    })
    const inspect = vi.spyOn(target, "inspect")
    try {
      const failure = await target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }, cancellation.signal)
        .then(() => undefined, (error: unknown) => error)
      await expect(lstat(claimPath)).rejects.toMatchObject({ code: "ENOENT" })
      expect(failure).toBe(reason)
      expect(inspect).not.toHaveBeenCalled()
      await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-1" })
    } finally { inspect.mockRestore() }
  })

  it("refuses a bundle it cannot verify", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-bad-")
    const damaged = join(scratch, "damaged.bundle")
    await writeFile(damaged, "not a bundle\n")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    await expect(target.restoreSessionFromBundle(
      damaged,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    ))
      .rejects.toThrow("Bundle could not be verified")
    await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
      .resolves.toMatchObject({ branch: "domovoi/session-1" })
  })

  it("refuses a session id that could escape the worktree root", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-escape-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    await expect(target.restoreSessionFromBundle(
      bundle.path,
      "../escape",
      { repositoryPath: targetRepositoryPath },
    ))
      .rejects.toThrow("Session id is not safe for a worktree")
  })
})

describe("GitWorkspaceService session refs", () => {
  async function sessionWithRemote(prefix: string) {
    const scratch = await mkdtemp(join(tmpdir(), prefix))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const remotePath = join(scratch, "remote.git")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await execute("git", ["init", "--bare", remotePath])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    await execute("git", ["-C", repositoryPath, "remote", "add", "origin", remotePath])
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await service.checkpoint(workspace.path, "before-transfer")
    return { scratch, service, workspace, checkpoint, remotePath }
  }

  it("pushes the session checkpoint to the remote the caller named", async () => {
    const { service, workspace, checkpoint, remotePath } = await sessionWithRemote("domovoi-ref-")

    const pushed = await service.pushSessionRef(workspace.path, "origin", "session-1")

    expect(pushed.ref).toBe("refs/domovoi/sessions/session-1")
    expect(pushed.commit).toBe(checkpoint.commit)
    const listed = await execute("git", ["-C", remotePath, "rev-parse", pushed.ref])
    expect(listed.stdout.trim()).toBe(checkpoint.commit)
  })

  it("refuses a remote the repository does not have", async () => {
    const { service, workspace } = await sessionWithRemote("domovoi-ref-missing-")

    await expect(service.pushSessionRef(workspace.path, "nowhere", "session-1"))
      .rejects.toThrow("Repository has no remote named nowhere")
  })

  it("refuses a remote name that could be read as an option", async () => {
    const { service, workspace } = await sessionWithRemote("domovoi-ref-option-")

    await expect(service.pushSessionRef(workspace.path, "--upload-pack=touch", "session-1"))
      .rejects.toThrow("Remote name is not safe")
  })

  it("refuses to push work that is not checkpointed", async () => {
    const { service, workspace } = await sessionWithRemote("domovoi-ref-dirty-")
    await writeFile(join(workspace.path, "README.md"), "uncommitted\n")

    await expect(service.pushSessionRef(workspace.path, "origin", "session-1"))
      .rejects.toThrow("Session worktree has work that is not checkpointed")
  })
})

describe("GitWorkspaceService session ref restore", () => {
  it("restores a session the source pushed to a shared remote", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-ref-restore-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const remotePath = join(scratch, "remote.git")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await execute("git", ["init", "--bare", remotePath])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    await execute("git", ["-C", repositoryPath, "remote", "add", "origin", remotePath])
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await source.checkpoint(workspace.path, "before-transfer")
    await source.pushSessionRef(workspace.path, "origin", "session-1")

    const targetClone = join(scratch, "target-project")
    await execute("git", ["clone", "--quiet", remotePath, targetClone])
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))
    const restored = await target.restoreSessionFromRef(
      targetClone,
      "origin",
      "session-1",
      checkpoint.commit,
    )

    expect(restored.baseCommit).toBe(checkpoint.commit)
    const contents = await readFile(join(restored.path, "README.md"), "utf8")
    expect(contents.replace(/\r\n/g, "\n")).toBe("moved\n")
    const durable = await execute("git", [
      "-C", restored.path,
      "rev-parse", `refs/domovoi/checkpoints/${checkpoint.commit}^{commit}`,
    ])
    expect(durable.stdout.trim()).toBe(checkpoint.commit)

    await expect(target.restoreSessionFromRef(
      targetClone,
      "origin",
      "session-1",
      checkpoint.commit,
    )).resolves.toEqual(restored)
    await expect(target.restoreSessionFromRef(
      targetClone,
      "origin",
      "session-1",
      new AbortController().signal,
    )).resolves.toEqual(restored)
    await expect(target.restoreSessionFromRef(
      targetClone,
      "origin",
      "session-1",
      "f".repeat(40),
    )).rejects.toThrow("Remote session ref changed before transfer commit")
  })

  it("pushes and restores checkpoint refs outside the current branch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-ref-history-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const remotePath = join(scratch, "remote.git")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await execute("git", ["init", "--bare", remotePath])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    await execute("git", ["-C", repositoryPath, "remote", "add", "origin", remotePath])
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")

    await writeFile(join(workspace.path, "README.md"), "abandoned branch\n")
    const historical = await source.checkpoint(workspace.path, "historical")
    await execute("git", ["-C", workspace.path, "reset", "--hard", workspace.baseCommit])
    await writeFile(join(workspace.path, "README.md"), "current branch\n")
    const current = await source.checkpoint(workspace.path, "current")
    const checkpoints = [historical.commit, current.commit]
    await source.pushSessionRef(
      workspace.path,
      "origin",
      "session-1",
      undefined,
      checkpoints,
    )

    const targetClone = join(scratch, "target-project")
    await execute("git", ["clone", "--quiet", remotePath, targetClone])
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))
    const restored = await target.restoreSessionFromRef(
      targetClone,
      "origin",
      "session-1",
      current.commit,
      undefined,
      checkpoints,
    )

    await expect(target.restore(restored.path, historical.commit)).resolves.toMatchObject({
      restoredCommit: historical.commit,
    })
  })
})

describe("GitWorkspaceService session head", () => {
  it("reports the commit it holds for a session it has", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-head-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await service.checkpoint(workspace.path, "before-transfer")

    await expect(service.sessionHeadCommit("session-1")).resolves.toBe(checkpoint.commit)
  })

  it("holds nothing for a session it has never seen", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-head-missing-"))
    scratchDirectories.push(scratch)
    const service = new GitWorkspaceService(join(scratch, "worktrees"))

    await expect(service.sessionHeadCommit("session-1")).resolves.toBeUndefined()
    await expect(service.sessionHeadCommit("../escape")).resolves.toBeUndefined()
  })
})

describe("GitWorkspaceService incremental restore", () => {
  it("applies a bundle onto a session it already holds", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-apply-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const targetRepositoryPath = join(scratch, "target-project")
    await execute("git", ["clone", "--quiet", repositoryPath, targetRepositoryPath])

    // The source moves the session once, so both machines share a base.
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "first\n")
    const first = await source.checkpoint(workspace.path, "first")
    const full = await source.bundleSession(workspace.path, join(scratch, "full.bundle"))
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))
    const restored = await target.restoreSessionFromBundle(
      full.path,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    )
    expect(restored.baseCommit).toBe(first.commit)

    // More work, then only what the target is missing travels.
    await writeFile(join(workspace.path, "README.md"), "second\n")
    const second = await source.checkpoint(workspace.path, "second")
    const incremental = await source.bundleSession(
      workspace.path,
      join(scratch, "incremental.bundle"),
      first.commit,
    )

    const updated = await target.restoreSessionFromBundle(
      incremental.path,
      "session-1",
      { repositoryPath: targetRepositoryPath },
    )

    expect(updated.baseCommit).toBe(second.commit)
    const contents = await readFile(join(updated.path, "README.md"), "utf8")
    expect(contents.replace(/\r\n/g, "\n")).toBe("second\n")
  })
})

describe("GitWorkspaceService file revert", () => {
  it("restores a tracked file after taking a recovery checkpoint", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-revert-tracked-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "kept.ts"), "original\n")
    await writeFile(join(repositoryPath, "other.ts"), "other original\n")
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

    const service = new GitWorkspaceService(worktreeRoot)
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-revert-tracked")
    await writeFile(join(workspace.path, "kept.ts"), "agent edit\n")
    await writeFile(join(workspace.path, "other.ts"), "other agent edit\n")

    const reverted = await service.revertFile(workspace.path, "kept.ts")

    expect(reverted).toMatchObject({ path: "kept.ts", outcome: "restored", baseCommit: workspace.baseCommit })
    expect(reverted.recoveryCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(await readFile(join(workspace.path, "kept.ts"), "utf8")).toBe("original\n")
    expect(await readFile(join(workspace.path, "other.ts"), "utf8")).toBe("other agent edit\n")
    expect((await execute("git", ["-C", workspace.path, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(workspace.baseCommit)
    expect((await execute("git", ["-C", workspace.path, "show", `${reverted.recoveryCommit}:kept.ts`])).stdout)
      .toBe("agent edit\n")
    expect((await execute("git", [
      "-C",
      workspace.path,
      "rev-parse",
      `refs/domovoi/checkpoints/${reverted.recoveryCommit}`,
    ])).stdout.trim()).toBe(reverted.recoveryCommit)
    expect((await execute("git", ["-C", workspace.path, "status", "--porcelain"])).stdout)
      .not.toContain("kept.ts")
  })

  it("removes an untracked file and refuses paths it cannot revert", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-revert-untracked-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await execute("git", ["-C", repositoryPath, "config", "core.eol", "lf"])
    await writeFile(join(repositoryPath, "README.md"), "source\n")
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

    const service = new GitWorkspaceService(worktreeRoot)
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-revert-untracked")
    await mkdir(join(workspace.path, "generated"), { recursive: true })
    await writeFile(join(workspace.path, "generated", "added.ts"), "agent file\n")

    const reverted = await service.revertFile(workspace.path, "generated/added.ts")

    expect(reverted).toMatchObject({ path: "generated/added.ts", outcome: "removed" })
    await expect(readFile(join(workspace.path, "generated", "added.ts"), "utf8")).rejects.toThrow()
    expect((await execute("git", [
      "-C",
      workspace.path,
      "show",
      `${reverted.recoveryCommit}:generated/added.ts`,
    ])).stdout).toBe("agent file\n")
    expect((await execute("git", ["-C", workspace.path, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(workspace.baseCommit)

    await expect(service.revertFile(workspace.path, "README.md")).rejects.toThrow(
      "File has no changes to revert",
    )
    await expect(service.revertFile(workspace.path, "../escape.ts")).rejects.toThrow(
      "File path must stay inside the session worktree",
    )
  })
})
