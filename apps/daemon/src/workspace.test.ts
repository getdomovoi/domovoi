import { execFile } from "node:child_process"
import { removeScratchDirectories } from "./test-scratch.js"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { GitWorkspaceService, WorkspaceEvidenceUnstableError } from "./workspace.js"

const execute = promisify(execFile)
const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

describe("GitWorkspaceService", () => {
  it("archives only the session worktree while retaining its branch and source checkout", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-archive-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
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

  it("retries when the worktree changes between Git evidence observations", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-evidence-generation-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
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

  it("does not execute a repository-configured file-system monitor", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-workspace-"))
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
})

describe("GitWorkspaceService session bundles", () => {
  async function repositoryWithSession(prefix: string) {
    const scratch = await mkdtemp(join(tmpdir(), prefix))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const worktreeRoot = join(scratch, "worktrees")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
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

describe("GitWorkspaceService bundle restore", () => {
  async function sourceWithBundle(prefix: string) {
    const scratch = await mkdtemp(join(tmpdir(), prefix))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath,
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await source.checkpoint(workspace.path, "before-transfer")
    const bundle = await source.bundleSession(workspace.path, join(scratch, "session.bundle"))
    return { scratch, checkpoint, bundle }
  }

  it("rebuilds the session worktree from a bundle", async () => {
    const { scratch, checkpoint, bundle } = await sourceWithBundle("domovoi-restore-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    const restored = await target.restoreSessionFromBundle(bundle.path, "session-1")

    expect(restored.baseCommit).toBe(checkpoint.commit)
    expect(restored.branch).toBe("domovoi/session-1")
    // Git checks out with the platform's line endings, so the transferred
    // content is compared rather than its exact bytes.
    const contents = await readFile(join(restored.path, "README.md"), "utf8")
    expect(contents.replace(/\r\n/g, "\n")).toBe("moved\n")
  })

  it("keeps the transferred checkpoint restorable on the target", async () => {
    const { scratch, checkpoint, bundle } = await sourceWithBundle("domovoi-restore-ref-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    const restored = await target.restoreSessionFromBundle(bundle.path, "session-1")

    // Restoring later asks for the checkpoint by its Domovoi ref, so the
    // transfer has to carry that ref, not only the commit.
    const durable = await execute("git", [
      "-C", restored.path,
      "rev-parse", `refs/domovoi/checkpoints/${checkpoint.commit}^{commit}`,
    ])
    expect(durable.stdout.trim()).toBe(checkpoint.commit)
  })

  it("never destroys a session worktree that is already there", async () => {
    const { scratch, bundle } = await sourceWithBundle("domovoi-restore-occupied-")
    const targetRoot = join(scratch, "target-worktrees")
    const target = new GitWorkspaceService(targetRoot)
    await target.restoreSessionFromBundle(bundle.path, "session-1")
    const occupied = join(targetRoot, "session-1")
    await writeFile(join(occupied, "uncommitted.txt"), "work in progress\n")

    await expect(target.restoreSessionFromBundle(bundle.path, "session-1"))
      .rejects.toThrow("Session worktree already exists")
    await expect(readFile(join(occupied, "uncommitted.txt"), "utf8"))
      .resolves.toContain("work in progress")
  })

  it("refuses a bundle it cannot verify", async () => {
    const { scratch } = await sourceWithBundle("domovoi-restore-bad-")
    const damaged = join(scratch, "damaged.bundle")
    await writeFile(damaged, "not a bundle\n")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    await expect(target.restoreSessionFromBundle(damaged, "session-1"))
      .rejects.toThrow("Bundle could not be verified")
  })

  it("refuses a session id that could escape the worktree root", async () => {
    const { scratch, bundle } = await sourceWithBundle("domovoi-restore-escape-")
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    await expect(target.restoreSessionFromBundle(bundle.path, "../escape"))
      .rejects.toThrow("Session id is not safe for a worktree")
  })
})
