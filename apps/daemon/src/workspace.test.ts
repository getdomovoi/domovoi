import { execFile, type ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import { removeScratchDirectories } from "./test-scratch.js"
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { projectRootRead } from "./repository-trust-apply.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"
import {
  GitWorkspaceService,
  RepositoryFilterRefusedError,
  RepositoryGitFilterRefusedError,
  utf8GitPaths,
  WorkspaceEvidenceUnstableError,
  type GitWorkspaceServiceOptions,
} from "./workspace.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile), unlink: vi.fn(actual.unlink) }
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

const gitDaemons: ChildProcess[] = []

afterEach(async () => {
  vi.mocked(open).mockReset()
  vi.mocked(readFile).mockReset()
  vi.mocked(unlink).mockReset()
  for (const daemon of gitDaemons.splice(0)) daemon.kill()
  await removeScratchDirectories(scratchDirectories)
})

// A shared remote served over git:// by a local git daemon for the test's
// life, push included. A session transfer refuses a repository remote on a
// local path or a file:// URL: the far side would run that repository's
// own hooks.
async function servedRemotes(basePath: string): Promise<{ url: (name: string) => string }> {
  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolvePort(typeof address === "object" && address ? address.port : 0))
    })
  })
  gitDaemons.push(execFile("git", [
    "daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${basePath}`, "--listen=127.0.0.1", `--port=${port}`, basePath,
  ]))
  const url = (name: string) => `git://127.0.0.1:${port}/${name}`
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await execute("git", ["ls-remote", url("")]).then(() => true, (error: { stderr?: string }) => !/Connection refused|unable to connect/iu.test(error.stderr ?? ""))
    if (ready) break
    await new Promise((wait) => setTimeout(wait, 100))
  }
  return { url }
}

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

  it("names the session branch and counts the files the source never received", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-unmerged-"))
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
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-unmerged")
    expect(await service.sessionBranchFacts(workspace.path, repositoryPath)).toEqual({ branch: workspace.branch, unmergedFiles: 0 })

    await writeFile(join(workspace.path, "README.md"), "session work\n")
    await writeFile(join(workspace.path, "handler.ts"), "export const handler = 1\n")
    await service.checkpoint(workspace.path, "before archive")
    expect(await service.sessionBranchFacts(workspace.path, repositoryPath)).toEqual({ branch: workspace.branch, unmergedFiles: 2 })

    // Once the source has the branch, nothing on it is unmerged.
    await execute("git", ["-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "merge", "--ff-only", workspace.branch])
    expect(await service.sessionBranchFacts(workspace.path, repositoryPath)).toEqual({ branch: workspace.branch, unmergedFiles: 0 })
  })

  describe("files the source never received, as review found them", () => {
    async function repository(prefix: string) {
      const scratch = await mkdtemp(join(tmpdir(), prefix))
      scratchDirectories.push(scratch)
      const repositoryPath = join(scratch, "project")
      await execute("git", ["init", "--initial-branch=main", repositoryPath])
      for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["user.name", "Test User"], ["user.email", "test@example.invalid"]] as const) {
        await execute("git", ["-C", repositoryPath, "config", key, value])
      }
      await writeFile(join(repositoryPath, "README.md"), "source\n")
      await execute("git", ["-C", repositoryPath, "add", "README.md"])
      await execute("git", ["-C", repositoryPath, "commit", "-m", "initial"])
      return { scratch, repositoryPath, service: new GitWorkspaceService(join(scratch, "worktrees")) }
    }

    it("reads the source checkout's HEAD when the source is a linked worktree", async () => {
      const { scratch, repositoryPath, service } = await repository("domovoi-unmerged-linked-")
      const source = join(scratch, "feature")
      await execute("git", ["-C", repositoryPath, "worktree", "add", "-b", "feature", source])
      const workspace = await service.createSessionWorkspace(source, "session-linked")
      await writeFile(join(workspace.path, "a.ts"), "a\n")
      await writeFile(join(workspace.path, "b.ts"), "b\n")
      await service.checkpoint(workspace.path, "work")
      // The main checkout takes the branch; the source, `feature`, does not.
      await execute("git", ["-C", repositoryPath, "merge", "--ff-only", workspace.branch])
      expect(await service.sessionBranchFacts(workspace.path, source)).toEqual({ branch: workspace.branch, unmergedFiles: 2 })
    })

    it("counts a submodule update even when the repository ignores submodules in diffs", async () => {
      const { repositoryPath, service } = await repository("domovoi-unmerged-submodule-")
      // A gitlink is only a commit id in the tree. Neither `worktree add` nor
      // the tree diff reads the submodule's objects, so none are made.
      const recorded = "1".repeat(40)
      const updated = "2".repeat(40)
      await execute("git", ["-C", repositoryPath, "update-index", "--add", "--cacheinfo", `160000,${recorded},library`])
      await execute("git", ["-C", repositoryPath, "commit", "-m", "add library"])
      const workspace = await service.createSessionWorkspace(repositoryPath, "session-submodule")
      await execute("git", ["-C", workspace.path, "update-index", "--cacheinfo", `160000,${updated},library`])
      await execute("git", ["-C", workspace.path, "commit", "-m", "bump library"])
      await execute("git", ["-C", repositoryPath, "config", "diff.ignoreSubmodules", "all"])
      expect(await service.sessionBranchFacts(workspace.path, repositoryPath)).toEqual({ branch: workspace.branch, unmergedFiles: 1 })
    })

    // A no-break space: whitespace to String.prototype.trim, and a name every
    // system can create. Windows cannot create a name of plain spaces, since
    // it drops trailing spaces from a name.
    it("counts a file whose name is only whitespace", async () => {
      const { repositoryPath, service } = await repository("domovoi-unmerged-whitespace-")
      const workspace = await service.createSessionWorkspace(repositoryPath, "session-whitespace")
      await writeFile(join(workspace.path, "\u00a0"), "space\n")
      // Committed with git directly: the checkpoint's own name list has the
      // same trimming, reported separately.
      await execute("git", ["-C", workspace.path, "add", "--", "\u00a0"])
      await execute("git", ["-C", workspace.path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "work"])
      expect(await service.sessionBranchFacts(workspace.path, repositoryPath)).toEqual({ branch: workspace.branch, unmergedFiles: 1 })
    })
  })

  describe("a file whose name is only whitespace", () => {
    // git() trims its output, which strips such a name from a NUL-delimited
    // list when it is the first or last entry. The name is a no-break space:
    // whitespace to String.prototype.trim, and a name every system can
    // create. Windows cannot create a name of plain spaces, since it drops
    // trailing spaces from a name.
    async function sessionWithWhitespaceFile(prefix: string) {
      const scratch = await mkdtemp(join(tmpdir(), prefix))
      scratchDirectories.push(scratch)
      const repositoryPath = join(scratch, "project")
      await execute("git", ["init", "--initial-branch=main", repositoryPath])
      for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["user.name", "Test User"], ["user.email", "test@example.invalid"]] as const) {
        await execute("git", ["-C", repositoryPath, "config", key, value])
      }
      await writeFile(join(repositoryPath, "README.md"), "source\n")
      await execute("git", ["-C", repositoryPath, "add", "README.md"])
      await execute("git", ["-C", repositoryPath, "commit", "-m", "initial"])
      const service = new GitWorkspaceService(join(scratch, "worktrees"))
      const workspace = await service.createSessionWorkspace(repositoryPath, `session-${prefix.replace(/\W/g, "")}`)
      await writeFile(join(workspace.path, "\u00a0"), "space\n")
      return { service, workspace }
    }

    it("is checkpointed when it is the only change", async () => {
      const { service, workspace } = await sessionWithWhitespaceFile("domovoi-checkpoint-space-")
      const checkpoint = await service.checkpoint(workspace.path, "space")
      expect(checkpoint.changedFiles).toEqual(["\u00a0"])
      const listed = (await execute("git", ["-C", workspace.path, "show", "--name-only", "-z", "--format=", checkpoint.commit])).stdout
      expect(listed.split("\0").filter(Boolean)).toEqual(["\u00a0"])
    })

    it("is named in the session's evidence", async () => {
      const { service, workspace } = await sessionWithWhitespaceFile("domovoi-evidence-space-")
      const evidence = await service.evidence(workspace.path)
      expect(evidence.files.map(({ path }) => path)).toContain("\u00a0")
    })
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
    const sessionStart = await execute("git", [
      "-C", workspace.path, "rev-parse", `refs/domovoi/checkpoints/${workspace.baseCommit}^{commit}`,
    ])
    expect(sessionStart.stdout.trim()).toBe(repository.head)
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

    await execute("git", [
      "-C", workspace.path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "unmanaged commit",
    ])
    const unmanaged = await execute("git", ["-C", workspace.path, "rev-parse", "HEAD"])
    await expect(service.restore(workspace.path, unmanaged.stdout.trim())).rejects.toThrow(
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
    await writeFile(join(repositoryPath, " leading space.ts"), "before\n")
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
    await writeFile(join(repositoryPath, " leading space.ts"), "after\n")
    await writeFile(join(repositoryPath, "binary.dat"), Buffer.from([0, 1, 3]))
    await execute("git", ["-C", repositoryPath, "mv", "src/old.ts", "src/new name.ts"])
    await rm(join(repositoryPath, "remove.txt"))
    await writeFile(join(repositoryPath, "untracked file.ts"), "export const fresh = true\n")

    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    expect(await service.evidence(repositoryPath)).not.toHaveProperty("revertTargets")
    const evidence = await service.evidence(repositoryPath, undefined, true)

    expect(evidence).toMatchObject({
      baseCommit,
      totalChangedFiles: 6,
      filesTruncated: false,
      diffTruncated: false,
    })
    expect(evidence.files).toEqual([
      expect.objectContaining({ path: " leading space.ts", status: "modified" }),
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
    expect(evidence).toHaveProperty("revertTargets", [
      { path: " leading space.ts", kind: "restore" },
      { path: "binary.dat", kind: "restore" },
      { path: "README.md", kind: "restore" },
      { path: "remove.txt", kind: "restore" },
      { path: "src/new name.ts", kind: "remove" },
      { path: "untracked file.ts", kind: "remove" },
    ])
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

  // Evidence reads in an isolated Git directory that drops the repository's
  // diff settings; a driver's binary flag starts nothing and keeps a file's
  // contents out of the diff, so it is carried.
  it("keeps a file the repository's diff driver marks binary out of the evidence diff", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-evidence-binary-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await writeFile(join(repositoryPath, ".gitattributes"), "secret.txt diff=redact\n")
    await writeFile(join(repositoryPath, "secret.txt"), "public\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", ["-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"])
    await execute("git", ["-C", repositoryPath, "config", "diff.redact.binary", "true"])
    await writeFile(join(repositoryPath, "secret.txt"), "sentinel-plaintext-value\n")

    const evidence = await new GitWorkspaceService(join(scratch, "worktrees")).evidence(repositoryPath)

    expect(evidence.files).toEqual([expect.objectContaining({ path: "secret.txt", binary: true })])
    expect(evidence.diff).not.toContain("sentinel-plaintext-value")
  })

  // Evidence with revert targets lists the commit's whole tree. In a partial
  // clone a tree it lacks is fetched only through the isolated directory,
  // with the person's own transport settings, never through the
  // repository's own core.sshCommand. The person's ssh here is `false`, so
  // the test reaches no network.
  it("lists revert targets without fetching a missing tree through the repository's own transport", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-evidence-tree-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const git = (...args: string[]) => execute("git", ["-C", repositoryPath, ...args])
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await git("config", "core.autocrlf", "false")
    await mkdir(join(repositoryPath, "sub"))
    await writeFile(join(repositoryPath, "sub", "nested.txt"), "nested\n")
    await writeFile(join(repositoryPath, "top.txt"), "top\n")
    await git("add", ".")
    await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial")
    // The index's cached trees let status and diff skip the subtree; listing
    // the whole tree needs it.
    const subtree = (await git("rev-parse", "HEAD:sub")).stdout.trim()
    await rm(join(repositoryPath, ".git", "objects", subtree.slice(0, 2), subtree.slice(2)))
    const markerPath = join(scratch, "transport-ran").replaceAll("\\", "/")
    const payload = join(scratch, "payload.sh").replaceAll("\\", "/")
    await writeFile(payload, `echo ran >> "${markerPath}"\nexit 1\n`)
    await git("config", "core.repositoryformatversion", "1")
    await git("config", "extensions.partialClone", "origin")
    await git("config", "remote.origin.promisor", "true")
    await git("config", "remote.origin.url", "ssh://git@example.invalid/project.git")
    await git("config", "core.sshCommand", `sh ${payload}`)
    await writeFile(join(repositoryPath, "top.txt"), "changed\n")
    const home = join(scratch, "home")
    await mkdir(home)
    await writeFile(join(home, ".gitconfig"), "[core]\n\tsshCommand = false\n")
    const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")
    try {
      await new GitWorkspaceService(join(scratch, "worktrees")).evidence(repositoryPath, undefined, true).catch(() => undefined)
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
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
    // The >1 MiB status regression requires these real files. Windows needs time
    // to stage them all, even with the suite's worker cap.
  }, 90_000)

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

  it("never runs hooks the session worktree can edit during checkpoint, restore or revert", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-checkpoint-hooks-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await writeFile(join(repositoryPath, "README.md"), "before\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    await execute("git", ["-C", repositoryPath, "config", "core.hooksPath", ".githooks"])

    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-hooks")
    const markerPath = join(scratch, "hook-ran").replaceAll("\\", "/")
    await mkdir(join(workspace.path, ".githooks"))
    for (const hook of [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "post-checkout",
      "post-index-change",
      "reference-transaction",
    ]) {
      await writeFile(
        join(workspace.path, ".githooks", hook),
        `#!/bin/sh\necho ${hook} >> "${markerPath}"\n`,
        { mode: 0o755 },
      )
    }
    await execute("git", [
      "-C", workspace.path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "control",
    ])
    await expect(readFile(markerPath, "utf8")).resolves.toContain("pre-commit")
    await rm(markerPath)

    await writeFile(join(workspace.path, "README.md"), "after\n")
    const checkpoint = await service.checkpoint(workspace.path, "before-agent-turn")
    await writeFile(join(workspace.path, "README.md"), "later\n")
    await service.restore(workspace.path, checkpoint.commit)
    await writeFile(join(workspace.path, "README.md"), "edited again\n")
    await service.revertFile(workspace.path, "README.md")

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  // The hard reset runs in an isolated Git directory, so the merge and
  // sequencer state it would clear in the worktree's own Git directory is
  // cleared there explicitly: a later commit must not pick up a stale parent.
  it("clears an unfinished merge from the session worktree when it restores a checkpoint", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-restore-merge-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    const git = (path: string, ...args: string[]) => execute("git", ["-C", path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", ...args])
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await git(repositoryPath, "config", "core.autocrlf", "false")
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await git(repositoryPath, "add", ".")
    await git(repositoryPath, "commit", "-m", "initial")
    await git(repositoryPath, "checkout", "-q", "-b", "side")
    await writeFile(join(repositoryPath, "side.txt"), "side\n")
    await git(repositoryPath, "add", ".")
    await git(repositoryPath, "commit", "-m", "side")
    await git(repositoryPath, "checkout", "-q", "main")
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-merge")
    await git(workspace.path, "merge", "--no-ff", "--no-commit", "side")
    const statePath = async (name: string) => resolve(workspace.path, (await git(workspace.path, "rev-parse", "--git-path", name)).stdout.trim())
    await expect(readFile(await statePath("MERGE_HEAD"), "utf8")).resolves.toMatch(/^[0-9a-f]{40}/u)

    await service.restore(workspace.path, workspace.baseCommit)

    for (const name of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"]) {
      await expect(readFile(await statePath(name), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    await expect(git(workspace.path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).rejects.toThrow()
    await expect(readFile(join(workspace.path, "side.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("checkpoints past a failing commit hook and a signing setup it cannot use", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-checkpoint-signing-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, "tracked.txt"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    await writeFile(join(repositoryPath, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    await execute("git", ["-C", repositoryPath, "config", "commit.gpgsign", "true"])
    await execute("git", ["-C", repositoryPath, "config", "gpg.program", join(scratch, "missing-signer")])
    await writeFile(join(repositoryPath, "tracked.txt"), "changed\n")

    const checkpoint = await new GitWorkspaceService(join(scratch, "worktrees"))
      .checkpoint(repositoryPath, "signed repository")

    expect(checkpoint.changedFiles).toEqual(["tracked.txt"])
    expect((await execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim()).toBe(checkpoint.commit)
    expect((await execute("git", ["-C", repositoryPath, "cat-file", "commit", "HEAD"])).stdout).not.toContain("gpgsig")
  })

  it("refuses checkpoint, restore, revert and transfer while the repository's own config sets a filter, and never runs it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-repository-filter-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await writeFile(join(repositoryPath, "victim.txt"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-filter")
    const checkpoint = await service.checkpoint(workspace.path, "before the filter")
    const markerPath = join(scratch, "filter-ran").replaceAll("\\", "/")
    await execute("git", ["-C", repositoryPath, "config", "filter.agent.clean", "sh ./payload.sh"])
    await execute("git", ["-C", repositoryPath, "config", "filter.agent.smudge", "sh ./payload.sh"])
    await writeFile(join(workspace.path, "payload.sh"), `echo ran >> "${markerPath}"\ncat\n`)
    await writeFile(join(workspace.path, ".gitattributes"), "victim.txt filter=agent\n")
    await writeFile(join(workspace.path, "victim.txt"), "changed\n")
    await execute("git", ["-C", workspace.path, "add", "victim.txt"])
    await expect(readFile(markerPath, "utf8")).resolves.toContain("ran")
    await rm(markerPath)
    await execute("git", ["-C", workspace.path, "reset", "-q"])
    await rm(markerPath, { force: true })

    const refused = expect.objectContaining({
      name: "RepositoryFilterRefusedError",
      message: expect.stringContaining("filter.agent.clean in local Git config"),
    })
    await expect(service.checkpoint(workspace.path, "after the filter")).rejects.toEqual(refused)
    await expect(service.restore(workspace.path, checkpoint.commit)).rejects.toEqual(refused)
    await expect(service.revertFile(workspace.path, "victim.txt")).rejects.toEqual(refused)
    await expect(service.bundleSession(workspace.path, join(scratch, "session.bundle"))).rejects.toEqual(refused)
    await expect(service.snapshot(workspace.path, "while the agent runs")).rejects.toBeInstanceOf(RepositoryFilterRefusedError)

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
    await expect(readFile(join(workspace.path, "victim.txt"), "utf8")).resolves.toBe("changed\n")
  })

  it("reads evidence with a repository-set filter treated as absent, so its command never runs", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-evidence-filter-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await writeFile(join(repositoryPath, "victim.txt"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const markerPath = join(scratch, "filter-ran").replaceAll("\\", "/")
    await execute("git", ["-C", repositoryPath, "config", "filter.agent.clean", "sh ./payload.sh"])
    await execute("git", ["-C", repositoryPath, "config", "filter.agent.required", "true"])
    await writeFile(join(repositoryPath, "payload.sh"), `echo ran >> "${markerPath}"\ncat\n`)
    await writeFile(join(repositoryPath, ".gitattributes"), "victim.txt filter=agent\n")
    await writeFile(join(repositoryPath, "victim.txt"), "changed\n")
    await execute("git", ["-C", repositoryPath, "diff", "HEAD", "--stat"])
    await expect(readFile(markerPath, "utf8")).resolves.toContain("ran")
    await rm(markerPath)

    const evidence = await new GitWorkspaceService(join(scratch, "worktrees")).evidence(repositoryPath)

    expect(evidence.files.map((file) => file.path)).toEqual(expect.arrayContaining(["victim.txt"]))
    expect(evidence.diff).toContain("+changed")
    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  it("ignores Git config the daemon's own environment carries", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-env-filter-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await writeFile(join(repositoryPath, "victim.txt"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const markerPath = join(scratch, "filter-ran").replaceAll("\\", "/")
    await writeFile(join(repositoryPath, "payload.sh"), `echo ran >> "${markerPath}"\ncat\n`)
    await writeFile(join(repositoryPath, ".gitattributes"), "victim.txt filter=inherited\n")
    await writeFile(join(repositoryPath, "victim.txt"), "changed\n")
    const inherited = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.inherited.clean",
      GIT_CONFIG_VALUE_0: "sh ./payload.sh",
    }
    const previous = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]))
    Object.assign(process.env, inherited)
    try {
      const checkpoint = await new GitWorkspaceService(join(scratch, "worktrees")).checkpoint(repositoryPath, "inherited env")
      expect(checkpoint.changedFiles).toEqual(expect.arrayContaining(["victim.txt"]))
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  it("keeps running a filter the person set in their global Git config", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-global-filter-"))
    scratchDirectories.push(scratch)
    const home = join(scratch, "home")
    await mkdir(home)
    await writeFile(join(home, ".gitconfig"), "[filter \"upper\"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n")
    const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")
    try {
      const repositoryPath = join(scratch, "project")
      await execute("git", ["init", "--initial-branch=main", repositoryPath])
      await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
      await writeFile(join(repositoryPath, ".gitattributes"), "*.txt filter=upper\n")
      await writeFile(join(repositoryPath, "note.txt"), "base\n")
      await execute("git", ["-C", repositoryPath, "add", "."])
      await execute("git", [
        "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
        "commit", "-m", "initial",
      ])
      await writeFile(join(repositoryPath, "note.txt"), "changed\n")

      const checkpoint = await new GitWorkspaceService(join(scratch, "worktrees")).checkpoint(repositoryPath, "global filter")

      expect((await execute("git", ["-C", repositoryPath, "show", `${checkpoint.commit}:note.txt`])).stdout).toBe("CHANGED\n")
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it.each([
    ["GIT_CONFIG", "points the scan at a harmless file while the repository's own config still applies"],
    ["GIT_CONFIG_GLOBAL", "names a worktree file as the person's global config"],
  ])("does not let an inherited %s decide which config counts: it %s", async (variable) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-config-variable-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await writeFile(join(repositoryPath, "victim.txt"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const markerPath = join(scratch, "filter-ran").replaceAll("\\", "/")
    await writeFile(join(repositoryPath, "payload.sh"), `echo ran >> "${markerPath}"\ncat\n`)
    await writeFile(join(repositoryPath, ".gitattributes"), "victim.txt filter=planted\n")
    const harmless = join(scratch, "harmless.gitconfig")
    await writeFile(harmless, "[user]\n\tname = Nobody\n")
    const plantedGlobal = join(repositoryPath, "planted.gitconfig")
    await writeFile(plantedGlobal, "[filter \"planted\"]\n\tclean = sh ./payload.sh\n")
    if (variable === "GIT_CONFIG") await execute("git", ["-C", repositoryPath, "config", "filter.planted.clean", "sh ./payload.sh"])
    await writeFile(join(repositoryPath, "victim.txt"), "changed\n")
    const previous = process.env[variable]
    process.env[variable] = variable === "GIT_CONFIG" ? harmless : plantedGlobal
    try {
      const service = new GitWorkspaceService(join(scratch, "worktrees"))
      if (variable === "GIT_CONFIG") {
        await expect(service.checkpoint(repositoryPath, "inherited config")).rejects.toThrow("filter.planted.clean in local Git config")
      } else {
        await service.checkpoint(repositoryPath, "inherited config")
      }
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  it.each([
    ["the commit itself fails", "commit"],
    ["the deadline expires after staging", "deadline"],
  ] as const)("puts the person's own staging back when %s", async (_name, failure) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-checkpoint-staging-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await writeFile(join(repositoryPath, "staged.txt"), "base\n")
    await writeFile(join(repositoryPath, "tracked.txt"), "base\n")
    await writeFile(join(repositoryPath, "remove.txt"), "remove me\n")
    await execute("git", ["-C", repositoryPath, "add", "."])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    await writeFile(join(repositoryPath, "staged.txt"), "staged by the person\n")
    await execute("git", ["-C", repositoryPath, "add", "staged.txt"])
    await writeFile(join(repositoryPath, "staged.txt"), "staged, then edited again\n")
    await writeFile(join(repositoryPath, "tracked.txt"), "changed\n")
    await rm(join(repositoryPath, "remove.txt"))
    await writeFile(join(repositoryPath, "fresh.txt"), "fresh\n")
    const observe = async () => ({
      head: (await execute("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim(),
      index: (await execute("git", ["-C", repositoryPath, "ls-files", "--stage"])).stdout,
      staged: (await execute("git", ["-C", repositoryPath, "diff", "--cached", "--name-only"])).stdout,
      status: (await execute("git", ["-C", repositoryPath, "status", "--porcelain"])).stdout,
    })
    const before = await observe()
    expect(before.staged).toBe("staged.txt\n")

    const branchLock = join(repositoryPath, ".git", "refs", "heads", "main.lock")
    const controller = new AbortController()
    const service = new GitWorkspaceService(join(scratch, "worktrees"), {
      afterCheckpointStaging: failure === "commit"
        ? () => writeFile(branchLock, "")
        : () => controller.abort(new Error("checkpoint timed out")),
    })
    await expect(service.checkpoint(repositoryPath, "blocked", controller.signal)).rejects.toThrow()
    await rm(branchLock, { force: true })

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

  // A bundle of a partial clone needs blobs the clone never fetched. Fetching
  // one would follow the repository's promisor remote with its own
  // core.sshCommand, so the bundle is made in an isolated Git directory with
  // lazy fetching off: the transfer fails instead.
  it("fails a bundle that needs a missing promised blob, and runs no repository transport command", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-bundle-partial-"))
    scratchDirectories.push(scratch)
    const source = join(scratch, "source")
    const clone = join(scratch, "clone")
    const markerPath = join(scratch, "transport-ran").replaceAll("\\", "/")
    const payload = join(scratch, "payload.sh").replaceAll("\\", "/")
    await writeFile(payload, `echo ran >> "${markerPath}"\nexit 1\n`)
    const git = (path: string, ...args: string[]) => execute("git", ["-C", path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", ...args])
    await execute("git", ["init", "--initial-branch=main", source])
    await git(source, "config", "uploadpack.allowFilter", "true")
    await writeFile(join(source, "old.txt"), "only in history\n")
    await git(source, "add", ".")
    await git(source, "commit", "-m", "old")
    await git(source, "rm", "-q", "old.txt")
    await writeFile(join(source, "README.md"), "base\n")
    await git(source, "add", ".")
    await git(source, "commit", "-m", "current")
    await execute("git", ["clone", "--quiet", "--no-local", "--filter=blob:none", pathToFileURL(source).href, clone])
    const oldBlob = (await git(clone, "rev-parse", "HEAD~1:old.txt")).stdout.trim()
    expect((await git(clone, "rev-list", "--objects", "--missing=print", "HEAD")).stdout).toContain(`?${oldBlob}`)
    await git(clone, "config", "core.autocrlf", "false")
    await git(clone, "remote", "set-url", "origin", "ssh://git@example.invalid/source.git")
    await git(clone, "config", "core.sshCommand", `sh ${payload}`)
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(clone, "session-partial")

    await expect(service.bundleSession(workspace.path, join(scratch, "session.bundle"))).rejects.toThrow()

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
    expect((await git(clone, "rev-list", "--objects", "--missing=print", "HEAD")).stdout).toContain(`?${oldBlob}`)
  })

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

  it("counts ignored transfer holdbacks without counting promoted artifacts or ordinary untracked files", async () => {
    const { service, workspace } = await repositoryWithIgnoredPreview()
    await writeFile(join(workspace.path, "draft.txt"), "this travels in the checkpoint\n")
    await writeFile(join(workspace.path, "previews", "held.txt"), "ignored\n")
    await writeFile(join(workspace.path, "previews", process.platform === "win32" ? "two-lines.txt" : "two\nlines.txt"), "ignored too\n")
    await expect(service.countIgnoredTransferFiles(workspace.path, [
      "previews/preview.html", "previews/preview.html",
    ])).resolves.toBe(2)
    await expect(service.countIgnoredTransferFiles(workspace.path, [])).resolves.toBe(3)
    await service.checkpoint(workspace.path, "transfer")
    await expect(service.countIgnoredTransferFiles(workspace.path, ["previews/preview.html"]))
      .resolves.toBe(2)
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
  // A rendezvous, not a deadline. The test holds a gate open across real Git
  // work, so a wall-clock timer here races the runner instead of catching a
  // hang: on a slow Windows runner it fired inside the restore under test and
  // failed the winner with this file's own error. The test timeout is the
  // deadline, and every gate is released in a finally block.
  function restoreGate() {
    let release = () => {}
    const promise = new Promise<void>((resolvePromise) => { release = resolvePromise })
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
      await Promise.race([
        reachedHead.promise,
        // A winner that settles without ever reaching its HEAD lookup fails
        // here with its own reason instead of hanging on a gate nobody opens.
        first.then(() => { throw new Error("The winning restore settled before its HEAD lookup") }),
      ])
      second = competing.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
      const settled = Promise.allSettled([first, second])
      await expect(competing.restoreSessionFromBundle(bundle.path, "session-2", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-2" })
      releaseFirst.release()
      const results = await settled
      // A rejected winner has to name its own failure. Reporting only the
      // status pair is what made this unreadable the last time CI caught it.
      if (results[0].status === "rejected") throw results[0].reason
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

  it.each([
    ["close", "completed", "resolve"], ["close", "failed", "reject"],
    ["read", "completed", "resolve"], ["read", "failed", "reject"],
    ["unlink", "completed", "resolve"], ["unlink", "failed", "reject"],
  ] as const)("bounds claim %s after a %s restore, then drains a late %s", async (phase, outcome, settlement) => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-release-deadline-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const competing = new GitWorkspaceService(root)
    const entered = restoreGate()
    const resume = restoreGate()
    const drained = restoreGate()
    const restoreError = Object.freeze(new Error("restore failed before cleanup"))
    const lateError = new Error("late claim I/O failure")
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const inspect = vi.spyOn(target, "inspect")
    if (outcome === "failed") inspect.mockRejectedValueOnce(restoreError)
    const hold = async () => {
      entered.release()
      await resume.promise
      drained.release()
      if (settlement === "reject") throw lateError
    }
    if (phase === "close") {
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args)
        const close = handle.close.bind(handle)
        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
          // Close the real descriptor so the replacement probe also runs on Windows.
          await close()
          await hold()
        })
        return handle
      })
    } else if (phase === "read") {
      vi.mocked(readFile).mockImplementationOnce(async (...args) => {
        const token = await actual.readFile(...args)
        await hold()
        return token
      })
    } else {
      vi.mocked(unlink).mockImplementationOnce(async (...args) => {
        // An absent pathname does not mean an unacknowledged unlink is safe
        // to overlap with a new owner. Keep exclusion until it settles.
        await actual.unlink(...args)
        await hold()
      })
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    let result: { error: unknown } | undefined
    const restoring = target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })
      .then(() => { result = { error: undefined } }, (error: unknown) => { result = { error } })
    try {
      await entered.promise
      await vi.advanceTimersByTimeAsync(10_000)
      expect(result, "restore must settle at the release deadline while I/O is still pending").toBeDefined()
      expect(result?.error).toMatchObject({
        name: "SessionRestoreClaimCleanupError", restoreCompleted: outcome === "completed", claimPath,
        message: expect.stringContaining("deadline"),
      })
      if (outcome === "failed") {
        expect((result?.error as Error).cause).toBe(restoreError)
        expect((result?.error as AggregateError).errors[0]).toBe(restoreError)
      }
      await expect(competing.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .rejects.toMatchObject({ name: "SessionRestoreClaimQuarantinedError", claimPath })
      // Quarantine is per session; unrelated restores still work.
      await expect(competing.restoreSessionFromBundle(bundle.path, "session-2", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-2" })

      const replacementToken = "replacement-owner"
      if (phase !== "unlink") {
        await actual.unlink(claimPath)
        await writeFile(claimPath, replacementToken, { flag: "wx" })
      }
      resume.release()
      await drained.promise
      await vi.advanceTimersByTimeAsync(0)
      if (phase !== "unlink") {
        // No ownership read or unlink may begin after a timed-out step drains,
        // even when a delayed read returns the original owner's token.
        await expect(actual.readFile(claimPath, "utf8")).resolves.toBe(replacementToken)
        await expect(competing.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
          .rejects.toThrow(claimPath)
        await actual.unlink(claimPath)
      }
      await expect(competing.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath }))
        .resolves.toMatchObject({ branch: "domovoi/session-1" })
    } finally {
      resume.release()
      await restoring
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
      inspect.mockRestore()
    }
  })

  it("does not delete an unverified claim when writing its owner token fails", async () => {
    const { scratch, targetRepositoryPath, bundle } = await sourceWithBundle("domovoi-restore-token-write-")
    const root = join(scratch, "target-worktrees")
    const claimPath = join(root, ".restore-claims", "session-1")
    const target = new GitWorkspaceService(root)
    const writeError = Object.freeze(new Error("claim token write failed"))
    // Source creation released its own claim. Observe only the target refusal.
    vi.mocked(unlink).mockClear()
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

  // A bundle's missing prerequisite must not be fetched from a promisor
  // remote the target repository names: that would run a serving side
  // chosen by the repository's config, here a local repository. The fetch
  // runs with lazy fetching off, so the transfer fails instead.
  it("refuses a bundle whose prerequisite the target lacks, and fetches nothing from the target's promisor remote", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-restore-prerequisite-"))
    scratchDirectories.push(scratch)
    const source = join(scratch, "source")
    const git = (path: string, ...args: string[]) => execute("git", ["-C", path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", ...args])
    await execute("git", ["init", "--initial-branch=main", source])
    await writeFile(join(source, "README.md"), "base\n")
    await git(source, "add", ".")
    await git(source, "commit", "-m", "base")
    await git(source, "branch", "base")
    await writeFile(join(source, "README.md"), "prerequisite\n")
    await git(source, "commit", "-am", "prerequisite")
    const prerequisite = (await git(source, "rev-parse", "HEAD")).stdout.trim()
    await writeFile(join(source, "README.md"), "arrived\n")
    await git(source, "commit", "-am", "arrived")
    const bundlePath = join(scratch, "incremental.bundle")
    await git(source, "bundle", "create", "--quiet", bundlePath, `^${prerequisite}`, "HEAD")
    const target = join(scratch, "target")
    await execute("git", ["clone", "--quiet", "--no-local", "--single-branch", "--branch", "base", source, target])
    // The target names the source as its promisor remote, by a local path.
    await git(target, "config", "core.repositoryformatversion", "1")
    await git(target, "config", "extensions.partialClone", "origin")
    await git(target, "config", "remote.origin.promisor", "true")
    const lacks = async () => execute("git", ["-C", target, "cat-file", "-e", prerequisite], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).then(() => false, () => true)
    expect(await lacks()).toBe(true)

    const service = new GitWorkspaceService(join(scratch, "target-worktrees"))
    await expect(service.restoreSessionFromBundle(bundlePath, "session-1", { repositoryPath: target })).rejects.toThrow("Bundle could not be verified")

    expect(await lacks()).toBe(true)
    await expect(lstat(join(scratch, "target-worktrees", "session-1"))).rejects.toThrow()
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
    const served = await servedRemotes(scratch)
    await execute("git", ["-C", repositoryPath, "remote", "add", "origin", served.url("remote.git")])
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await service.checkpoint(workspace.path, "before-transfer")
    return { scratch, service, workspace, checkpoint, remotePath, repositoryPath }
  }

  // A repository can track a bare repository of its own, hooks included, and
  // name it as a remote. Pushing to it would run its receive hooks as the
  // person, and fetching from it its upload side; a remote on a local path or
  // a file:// URL is refused, and nothing on the far side runs.
  it.each([
    ["a local path", (path: string) => join(path, "target.git")],
    ["a file URL", (path: string) => pathToFileURL(join(path, "target.git")).href],
  ])("refuses a repository remote on %s, and runs none of its hooks", async (_label, address) => {
    const { scratch, service, workspace, checkpoint, repositoryPath } = await sessionWithRemote("domovoi-ref-local-")
    const target = join(repositoryPath, "target.git")
    const markerPath = join(scratch, "hook-ran").replaceAll("\\", "/")
    await execute("git", ["init", "--quiet", "--bare", target])
    for (const hook of ["pre-receive", "update", "post-receive", "reference-transaction", "pre-upload-pack"]) {
      await writeFile(join(target, "hooks", hook), `#!/bin/sh\necho ${hook} >> "${markerPath}"\nexit 1\n`, { mode: 0o755 })
    }
    await execute("git", ["-C", repositoryPath, "remote", "add", "tracked", address(repositoryPath)])

    await expect(service.pushSessionRef(workspace.path, "tracked", "session-1")).rejects.toMatchObject({ name: "RepositoryRemoteRefusedError" })
    const targetService = new GitWorkspaceService(join(scratch, "target-worktrees"))
    await expect(targetService.restoreSessionFromRef(repositoryPath, "tracked", "session-2", checkpoint.commit))
      .rejects.toMatchObject({ name: "RepositoryRemoteRefusedError" })

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  it("pushes without the repository's own ssh command", async () => {
    const { scratch, service, workspace } = await sessionWithRemote("domovoi-ref-ssh-")
    const repositoryPath = join(scratch, "project")
    const markerPath = join(scratch, "transport-ran").replaceAll("\\", "/")
    await writeFile(join(workspace.path, "evil.sh"), `echo ran >> "${markerPath}"\nexit 1\n`)
    await execute("git", ["-C", repositoryPath, "remote", "set-url", "origin", "ssh://git@example.invalid/remote.git"])
    await execute("git", ["-C", repositoryPath, "config", "core.sshCommand", "sh ./evil.sh"])
    await service.checkpoint(workspace.path, "with the script")

    await expect(service.pushSessionRef(workspace.path, "origin", "session-1")).rejects.toThrow()

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  it("pushes without the repository's own credential helpers, keeping the person's", async () => {
    const { scratch, service, workspace } = await sessionWithRemote("domovoi-ref-credential-")
    const repositoryPath = join(scratch, "project")
    const markerPath = join(scratch, "helper-ran").replaceAll("\\", "/")
    await writeFile(join(workspace.path, "evil.sh"), `echo ran >> "${markerPath}"\n`)
    await service.checkpoint(workspace.path, "with the script")
    const server = createServer((_request, response) => {
      response.writeHead(401, { "www-authenticate": "Basic realm=\"test\"" })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address() as { port: number }
      await execute("git", ["-C", repositoryPath, "remote", "set-url", "origin", `http://127.0.0.1:${port}/remote.git`])
      await execute("git", ["-C", repositoryPath, "config", "credential.helper", "!sh ./evil.sh"])
      await execute("git", ["-C", repositoryPath, "config", `credential.http://127.0.0.1:${port}.helper`, "!sh ./evil.sh"])
      const previousPrompt = process.env.GIT_TERMINAL_PROMPT
      process.env.GIT_TERMINAL_PROMPT = "0"
      try {
        await expect(service.pushSessionRef(workspace.path, "origin", "session-1")).rejects.toThrow()
      } finally {
        if (previousPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT
        else process.env.GIT_TERMINAL_PROMPT = previousPrompt
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

  // Git starts git-remote-<helper> for a `<helper>::` URL or a remote's vcs
  // setting. Push and fetch allow only the transports a session transfer
  // uses, and refuse a remote whose URL names any other. The stand-in helper
  // is an extensionless script, which Git for Windows does not run (as for
  // the fake git-lfs, ruling Q225).
  it.skipIf(process.platform === "win32").each([
    ["a helper URL", (git: (...args: string[]) => Promise<unknown>) => git("remote", "add", "probe", "probe::payload")],
    ["a vcs setting", async (git: (...args: string[]) => Promise<unknown>) => {
      await git("remote", "add", "probe", "https://example.invalid/remote.git")
      await git("config", "remote.probe.vcs", "probe")
    }],
  ])("launches no remote helper the repository names through %s on push or fetch", async (_label, configure) => {
    const { scratch, service, workspace, checkpoint } = await sessionWithRemote("domovoi-ref-helper-")
    const repositoryPath = join(scratch, "project")
    const markerPath = join(scratch, "helper-launched").replaceAll("\\", "/")
    const bin = join(scratch, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "git-remote-probe"), `#!/bin/sh\necho launched >> "${markerPath}"\nexit 1\n`, { mode: 0o755 })
    await configure((...args: string[]) => execute("git", ["-C", repositoryPath, ...args]))
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ""}`
    try {
      await expect(service.pushSessionRef(workspace.path, "probe", "session-1")).rejects.toThrow()
      const target = new GitWorkspaceService(join(scratch, "target-worktrees"))
      await expect(target.restoreSessionFromRef(repositoryPath, "probe", "session-2", checkpoint.commit)).rejects.toThrow()
    } finally {
      process.env.PATH = previousPath
    }

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })

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
    const served = await servedRemotes(scratch)
    await execute("git", ["-C", repositoryPath, "remote", "add", "origin", served.url("remote.git")])
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "moved\n")
    const checkpoint = await source.checkpoint(workspace.path, "before-transfer")
    await source.pushSessionRef(workspace.path, "origin", "session-1")

    const targetClone = join(scratch, "target-project")
    await execute("git", ["clone", "--quiet", served.url("remote.git"), targetClone])
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
    const served = await servedRemotes(scratch)
    await execute("git", ["-C", repositoryPath, "remote", "add", "origin", served.url("remote.git")])
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
    await execute("git", ["clone", "--quiet", served.url("remote.git"), targetClone])
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
  it("scans the held session worktree's own config before applying a bundle to it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-apply-filter-"))
    scratchDirectories.push(scratch)
    const repositoryPath = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", repositoryPath])
    await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
    await writeFile(join(repositoryPath, "README.md"), "base\n")
    await execute("git", ["-C", repositoryPath, "add", "README.md"])
    await execute("git", [
      "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "-m", "initial",
    ])
    const targetRepositoryPath = join(scratch, "target-project")
    await execute("git", ["clone", "--quiet", repositoryPath, targetRepositoryPath])
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "README.md"), "first\n")
    const first = await source.checkpoint(workspace.path, "first")
    const full = await source.bundleSession(workspace.path, join(scratch, "full.bundle"))
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))
    const restored = await target.restoreSessionFromBundle(full.path, "session-1", { repositoryPath: targetRepositoryPath })
    await execute("git", ["-C", targetRepositoryPath, "config", "extensions.worktreeConfig", "true"])
    await execute("git", ["-C", restored.path, "config", "--worktree", "filter.held.smudge", "sh ./payload.sh"])

    await writeFile(join(workspace.path, "README.md"), "second\n")
    await source.checkpoint(workspace.path, "second")
    const incremental = await source.bundleSession(workspace.path, join(scratch, "incremental.bundle"), first.commit)

    await expect(target.restoreSessionFromBundle(incremental.path, "session-1", { repositoryPath: targetRepositoryPath }))
      .rejects.toThrow("filter.held.smudge in worktree Git config")
  })

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

    // A confirmation read before another checkpoint must not silently restore
    // from that newer commit. Refusal happens before even the recovery write.
    const confirmed = await service.evidence(workspace.path)
    const newer = await service.checkpoint(workspace.path, "newer baseline")
    await writeFile(join(workspace.path, "kept.ts"), "keep this work\n")
    const checkpoint = vi.spyOn(service, "checkpoint")
    await expect(service.revertFile(workspace.path, "kept.ts", undefined, confirmed.baseCommit))
      .rejects.toThrow("Revert target changed; refresh file evidence before confirming again")
    expect(checkpoint).not.toHaveBeenCalled()
    expect(await readFile(join(workspace.path, "kept.ts"), "utf8")).toBe("keep this work\n")
    expect((await execute("git", ["-C", workspace.path, "rev-parse", "HEAD"])).stdout.trim())
      .toBe(newer.commit)
    await expect(service.revertFile(workspace.path, "kept.ts", undefined, newer.commit))
      .resolves.toMatchObject({ outcome: "restored", baseCommit: newer.commit })
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

// Checking a new session worktree out runs every filter its .gitattributes
// selects. One the repository's own Git config sets is refused before it can
// run: the worktree is added without a checkout, Git's config is read as the
// new worktree reads it, and only then is it checked out or taken away
// (ruling Q3 A).
describe("GitWorkspaceService checkout under repository git filters", () => {
  // The test's own Git commands read no global or system config, so a runner
  // with git-lfs installed globally sees what any other machine sees. The
  // service still reads the person's config as it always does.
  let isolated: NodeJS.ProcessEnv = process.env
  const run = (...args: string[]) => execute("git", args, { env: isolated })

  async function filteredRepository(prefix: string) {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    scratchDirectories.push(scratch)
    await writeFile(join(scratch, "empty.gitconfig"), "")
    isolated = { ...process.env, GIT_CONFIG_GLOBAL: join(scratch, "empty.gitconfig"), GIT_CONFIG_SYSTEM: join(scratch, "empty.gitconfig") }
    const repositoryPath = join(scratch, "project")
    const markerPath = join(scratch, "filter-ran").replaceAll("\\", "/")
    const payload = join(scratch, "payload.sh").replaceAll("\\", "/")
    await writeFile(payload, `echo ran >> "${markerPath}"\ncat\n`)
    const git = (...args: string[]) => run("-C", repositoryPath, ...args)
    await run("init", "--initial-branch=main", repositoryPath)
    await git("config", "core.autocrlf", "false")
    await writeFile(join(repositoryPath, ".gitattributes"), "victim.txt filter=agent\n")
    await writeFile(join(repositoryPath, "victim.txt"), "base\n")
    await git("add", ".")
    await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial")
    const filterFile = join(scratch, "agent.gitconfig")
    await writeFile(filterFile, `[filter "agent"]\n\tsmudge = sh ${payload}\n\tclean = sh ${payload}\n`)
    const worktrees = join(scratch, "worktrees")
    const ran = async () => readFile(markerPath, "utf8").then(() => true, () => false)
    const branches = async () => (await git("branch", "--list", "--format=%(refname:short)", "domovoi/*")).stdout.trim()
    const worktreeList = async () => (await git("worktree", "list", "--porcelain")).stdout.split("\n").filter((line) => line.startsWith("worktree "))
    return { scratch, repositoryPath, payload, filterFile, worktrees, git, ran, branches, worktreeList }
  }

  // A checkout the person's own required filter fails (git-lfs missing, say)
  // leaves no worktree or branch behind.
  it("takes the new worktree and its branch away when the checkout itself fails", async () => {
    const { scratch, repositoryPath, worktrees, branches, worktreeList } = await filteredRepository("domovoi-create-checkout-fails-")
    const home = join(scratch, "home")
    await mkdir(home)
    await writeFile(join(home, ".gitconfig"), "[filter \"agent\"]\n\tsmudge = false\n\trequired = true\n")
    const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")
    try {
      await expect(new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-checkout-fails")).rejects.toThrow()
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    await expect(lstat(join(worktrees, "session-checkout-fails"))).rejects.toThrow()
    expect(await branches()).toBe("")
    expect(await worktreeList()).toHaveLength(1)
  })

  // A driver's name is the repository's text and can hold a credential; the
  // refusal's message reaches clients, so it shows names as the inventory does.
  it("shows a filter's name and key redacted in a refusal's message", async () => {
    const { repositoryPath, worktrees, git } = await filteredRepository("domovoi-create-redact-")
    await git("config", "filter.api_token=sekret-value.smudge", "cat")
    await git("config", "filter.Bearer sekret-token.clean", "cat")

    const message = await new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-redact")
      .then(() => "", (error: Error) => error.message)
    expect(message).toContain("[REDACTED]")
    expect(message).not.toContain("sekret")

    const service = new GitWorkspaceService(worktrees)
    const checkpoint = await service.checkpoint(repositoryPath, "redact").then(() => "", (error: Error) => error.message)
    expect(checkpoint).toContain("Checkpoint, restore, revert")
    expect(checkpoint).not.toContain("sekret")
  })

  it("refuses to check a new session out when the repository's own config sets a filter, and leaves nothing behind", async () => {
    const { repositoryPath, payload, worktrees, git, ran, branches, worktreeList } = await filteredRepository("domovoi-create-filter-")
    await git("config", "filter.agent.smudge", `sh ${payload}`)
    const service = new GitWorkspaceService(worktrees)

    const refused = service.createSessionWorkspace(repositoryPath, "session-filter")

    await expect(refused).rejects.toBeInstanceOf(RepositoryGitFilterRefusedError)
    await expect(refused).rejects.toBeInstanceOf(RepositoryFilterRefusedError)
    await expect(refused).rejects.toMatchObject({
      drivers: [{ name: "agent", scope: "local" }],
      worktreeRemoved: true,
      message: expect.stringContaining("filter.agent.smudge in local Git config"),
    })
    expect(await ran()).toBe(false)
    await expect(lstat(join(worktrees, "session-filter"))).rejects.toThrow()
    expect(await branches()).toBe("")
    expect(await worktreeList()).toHaveLength(1)
  })

  it("refuses a filter only the new session's branch includes, after adding it without a checkout", async () => {
    const { repositoryPath, filterFile, worktrees, git, ran, branches, worktreeList } = await filteredRepository("domovoi-create-onbranch-")
    await git("config", "includeIf.onbranch:domovoi/**.path", filterFile)
    // Read at the main checkout, on main, the repository's own config sets no filter.
    expect((await git("config", "--local", "--includes", "--get-regexp", "^filter\\.").catch(() => ({ stdout: "" }))).stdout).toBe("")
    const service = new GitWorkspaceService(worktrees)

    await expect(service.createSessionWorkspace(repositoryPath, "session-onbranch")).rejects.toMatchObject({
      name: "RepositoryGitFilterRefusedError",
      drivers: [{ name: "agent", scope: "local" }],
      worktreeRemoved: true,
    })
    expect(await ran()).toBe(false)
    await expect(lstat(join(worktrees, "session-onbranch"))).rejects.toThrow()
    expect(await branches()).toBe("")
    expect(await worktreeList()).toHaveLength(1)
  })

  // Another session's agent can write the shared config between the scan and
  // the checkout. The checkout pins every driver its attributes can select to
  // what the scan approved, so a driver defined after the scan runs nothing.
  // Ruling Q223: the checkout runs in an isolated Git directory whose config
  // is the person's global and system config and what the daemon carries, so
  // nothing a filter or git-lfs reads from Git config comes from the
  // repository. A fake git-lfs stands in for the real one (none on this
  // machine): like git-lfs 3.8.0 it reads core.sshCommand, core.askPass and
  // the credential helper from `git config` and starts them, and it records
  // the object store and the remote it would take its endpoint from.
  async function lfsRepository(prefix: string) {
    const repository = await filteredRepository(prefix)
    const { scratch, repositoryPath, git } = repository
    await writeFile(join(repositoryPath, ".gitattributes"), "victim.txt filter=agent\n*.bin filter=lfs\n")
    await writeFile(join(repositoryPath, "object.bin"), "object\n")
    await git("add", ".")
    await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "lfs")
    const bin = join(scratch, "bin")
    await mkdir(bin)
    const seen = (name: string) => join(scratch, `lfs-seen-${name}`).replaceAll("\\", "/")
    // Node answers both ways git runs git-lfs: `git-lfs smudge -- <file>`,
    // which passes the content through, and `git-lfs filter-process`, the
    // long-running pkt-line protocol (gitprotocol-long-running-process).
    const fake = join(scratch, "fake-git-lfs.mjs").replaceAll("\\", "/")
    await writeFile(fake, [
      "import { execFileSync } from \"node:child_process\"",
      "import { writeFileSync } from \"node:fs\"",
      "const config = (...args) => { try { return execFileSync(\"git\", [\"config\", ...args], { encoding: \"utf8\" }).trim() } catch { return \"\" } }",
      `writeFileSync(${JSON.stringify(seen("storage"))}, config("--get", "lfs.storage"))`,
      `writeFileSync(${JSON.stringify(seen("remote"))}, config("--get", "remote.origin.url"))`,
      "for (const value of [",
      "  ...[\"core.sshcommand\", \"core.askpass\", \"credential.helper\"].map((key) => config(\"--get\", key)),",
      "  config(\"--get-urlmatch\", \"credential.helper\", \"https://lfs.example.test/repo\"),",
      "]) if (value.includes(\"payload\")) execFileSync(\"sh\", [\"-c\", value])",
      "if (process.argv[2] !== \"filter-process\") {",
      "  process.stdin.pipe(process.stdout)",
      "} else {",
      "  let buffer = Buffer.alloc(0)",
      "  let ended = false",
      "  const waiting = []",
      "  const take = () => {",
      "    if (buffer.length < 4) return undefined",
      "    const length = parseInt(buffer.subarray(0, 4).toString(), 16)",
      "    if (length === 0) { buffer = buffer.subarray(4); return \"flush\" }",
      "    if (buffer.length < length) return undefined",
      "    const packet = buffer.subarray(4, length)",
      "    buffer = buffer.subarray(length)",
      "    return packet",
      "  }",
      "  const pump = () => {",
      "    while (waiting.length > 0) {",
      "      const packet = take()",
      "      if (packet === undefined && !ended) return",
      "      waiting.shift()(packet ?? null)",
      "    }",
      "  }",
      "  process.stdin.on(\"data\", (chunk) => { buffer = Buffer.concat([buffer, chunk]); pump() })",
      "  process.stdin.on(\"end\", () => { ended = true; pump() })",
      "  const read = () => new Promise((resolve) => { waiting.push(resolve); pump() })",
      "  const list = async () => { const items = []; for (;;) { const packet = await read(); if (packet === null) return null; if (packet === \"flush\") return items; items.push(packet) } }",
      "  const write = (data) => { const body = Buffer.from(data); process.stdout.write(Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, \"0\")), body])) }",
      "  const flush = () => process.stdout.write(\"0000\")",
      "  await list()",
      "  write(\"git-filter-server\\n\"); write(\"version=2\\n\"); flush()",
      "  await list()",
      "  write(\"capability=clean\\n\"); write(\"capability=smudge\\n\"); flush()",
      "  for (;;) {",
      "    if (await list() === null) break",
      "    const content = Buffer.concat(await list() ?? [])",
      "    write(\"status=success\\n\"); flush()",
      "    for (let at = 0; at < content.length; at += 65516) write(content.subarray(at, at + 65516))",
      "    flush(); flush()",
      "  }",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(bin, "git-lfs"), [
      "#!/bin/sh",
      `exec "${process.execPath.replaceAll("\\", "/")}" "${fake}" "$@"`,
      "",
    ].join("\n"), { mode: 0o755 })
    await git("config", "filter.lfs.smudge", "git-lfs smudge -- %f")
    await git("config", "filter.lfs.required", "true")
    const seenText = async (name: string) => (await readFile(seen(name), "utf8")).trim()
    // A home of the test's own whose config holds the lines `git lfs install`
    // writes, as CI runners have them in their system config. The daemon's
    // git reads the person's own global and system config as it always does,
    // so the fake has to answer the long-running filter protocol either way.
    const withLfs = async <T>(work: () => Promise<T>): Promise<T> => {
      const home = join(scratch, "home")
      await mkdir(home, { recursive: true })
      await writeFile(join(home, ".gitconfig"), [
        "[filter \"lfs\"]", "\tclean = git-lfs clean -- %f", "\tsmudge = git-lfs smudge -- %f",
        "\tprocess = git-lfs filter-process", "\trequired = true", "",
      ].join("\n"))
      const previous = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
      process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${previous.PATH ?? ""}`
      process.env.HOME = home
      process.env.XDG_CONFIG_HOME = join(home, ".config")
      try {
        return await work()
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
    }
    const create = (sessionId: string) => withLfs(() => new GitWorkspaceService(repository.worktrees).createSessionWorkspace(repositoryPath, sessionId))
    return { ...repository, create, seenText, withLfs }
  }

  // Git for Windows does not run the extensionless test wrapper that stands in
  // for git-lfs. The isolation these tests check is platform-independent code,
  // and macOS and Linux cover it (as ruling Q110 A did for the keeper tests).
  const fakeLfsRuns = process.platform !== "win32"

  it.skipIf(!fakeLfsRuns).each([
    ["core.sshCommand", "ssh"], ["core.askPass", "askpass"], ["credential.helper", "helper"],
    ["credential.https://lfs.example.test.helper", "url-helper"],
  ])(
    "runs no program the repository's %s names through the exempt Git LFS lines",
    async (key, label) => {
      const { repositoryPath, payload, git, ran, create, seenText } = await lfsRepository("domovoi-create-lfs-delegate-")
      await git("config", key, `sh ${payload}`)

      const workspace = await create(`session-lfs-${label}`)

      expect(await readFile(join(workspace.path, "object.bin"), "utf8")).toBe("object\n")
      expect(await ran()).toBe(false)
      // git-lfs keeps finding the repository's own object store.
      expect(await seenText("storage")).toBe(join(await realpath(join(repositoryPath, ".git")), "lfs"))
    },
  )

  // Ruling Q224: git-lfs takes a missing object's endpoint from the remote,
  // as it normally would, with the person's own transport settings.
  it.skipIf(!fakeLfsRuns)("lets git-lfs find its endpoint from the repository's remote, and still runs none of its commands", async () => {
    const { payload, git, ran, create, seenText } = await lfsRepository("domovoi-create-lfs-remote-")
    await git("remote", "add", "origin", "https://lfs.example.test/repo.git")
    await git("config", "core.sshCommand", `sh ${payload}`)

    await create("session-lfs-remote")

    expect(await seenText("remote")).toBe("https://lfs.example.test/repo.git")
    expect(await ran()).toBe(false)
  })

  it.skipIf(!fakeLfsRuns).each([
    ["ext::sh -c %S", "ext"], ["fd::7", "fd"], ["file:///tmp/elsewhere.git", "file"], ["helper::https://example.test/x", "helper"],
    ["/tmp/elsewhere.git", "path"], ["-oProxyCommand=sh:x", "dash-host"],
  ])("does not carry a remote url of the form %s into the checkout", async (url, label) => {
    const { git, ran, create, seenText } = await lfsRepository("domovoi-create-lfs-remote-form-")
    await git("config", "remote.origin.url", url)

    await create(`session-lfs-form-${label}`)

    expect(await seenText("remote")).toBe("")
    expect(await ran()).toBe(false)
  })

  // Ruling Q224: a partial clone's missing blob is fetched from its promisor
  // remote during the checkout, over a transport the daemon allows (git://
  // here, served by a local git daemon for the test's life).
  it("creates a session in a blob:none partial clone, fetching the blobs the checkout needs", async () => {
    const { scratch, git } = await filteredRepository("domovoi-create-partial-")
    await git("config", "uploadpack.allowFilter", "true")
    await git("config", "uploadpack.allowAnySHA1InWant", "true")
    const port = await new Promise<number>((resolvePort, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        probe.close(() => resolvePort(typeof address === "object" && address ? address.port : 0))
      })
    })
    const daemon = execFile("git", [
      "daemon", "--reuseaddr", "--export-all", "--enable=upload-pack", `--base-path=${scratch}`, "--listen=127.0.0.1", `--port=${port}`, scratch,
    ], { env: isolated })
    try {
      const clone = join(scratch, "partial")
      const url = `git://127.0.0.1:${port}/project`
      let cloned = false
      for (let attempt = 0; attempt < 50 && !cloned; attempt += 1) {
        cloned = await run("clone", "--quiet", "--no-checkout", "--filter=blob:none", url, clone).then(() => true, async () => {
          await new Promise((wait) => setTimeout(wait, 100))
          return false
        })
      }
      expect(cloned).toBe(true)
      // The clone checked nothing out, so the blobs of HEAD are not here.
      const blob = (await run("-C", clone, "rev-parse", "HEAD:victim.txt")).stdout.trim()
      // --missing=print lists a missing object with a leading "?" and fetches nothing.
      const missing = async () => (await run("-C", clone, "rev-list", "--objects", "--missing=print", "HEAD")).stdout
      expect(await missing()).toContain(`?${blob}`)

      // A home of the test's own with core.autocrlf=false, over Git for
      // Windows' system default of true, so the checked-out bytes are the
      // blob's on every platform.
      const home = join(scratch, "home")
      await mkdir(home)
      await writeFile(join(home, ".gitconfig"), "[core]\n\tautocrlf = false\n")
      const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
      process.env.HOME = home
      process.env.XDG_CONFIG_HOME = join(home, ".config")
      let workspace: Awaited<ReturnType<GitWorkspaceService["createSessionWorkspace"]>>
      try {
        workspace = await new GitWorkspaceService(join(scratch, "partial-worktrees")).createSessionWorkspace(clone, "session-partial")
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }

      expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\n")
      expect(await missing()).not.toContain(`?${blob}`)
      expect((await run("-C", workspace.path, "status", "--porcelain")).stdout).toBe("")
    } finally {
      daemon.kill()
    }
  }, 30_000)

  // A checkout directory an earlier daemon left behind (it crashed mid
  // checkout) is removed by the next checkout in that repository, once it is
  // old enough not to be another checkout still running.
  it("sweeps stale checkout directories from the repository's Git directory, and only those", async () => {
    const { repositoryPath, worktrees } = await filteredRepository("domovoi-create-sweep-")
    const gitDirectory = join(repositoryPath, ".git")
    const stale = join(gitDirectory, "domovoi-checkout-00000000-0000-4000-8000-000000000001")
    const fresh = join(gitDirectory, "domovoi-checkout-00000000-0000-4000-8000-000000000002")
    const unrelated = join(gitDirectory, "domovoi-checkout-notes")
    for (const directory of [stale, fresh, unrelated]) await mkdir(join(directory, "objects"), { recursive: true })
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(stale, old, old)
    await utimes(unrelated, old, old)

    await new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-sweep")

    await expect(lstat(stale)).rejects.toThrow()
    expect((await lstat(fresh)).isDirectory()).toBe(true)
    expect((await lstat(unrelated)).isDirectory()).toBe(true)
  })

  // A checkout can outlast the age threshold (a longer operation timeout, a
  // stalled LFS fetch), so its directory carries an owner file with the pid
  // that made it; the sweep never removes one whose owner is still running.
  it("keeps an old checkout directory whose owner is alive, and removes one whose owner is gone", async () => {
    const { repositoryPath, worktrees } = await filteredRepository("domovoi-create-sweep-owner-")
    const gitDirectory = join(repositoryPath, ".git")
    const live = join(gitDirectory, "domovoi-checkout-00000000-0000-4000-8000-000000000003")
    const dead = join(gitDirectory, "domovoi-checkout-00000000-0000-4000-8000-000000000004")
    const exited = await new Promise<number>((resolvePid, reject) => {
      const child = execFile(process.execPath, ["-e", ""])
      child.once("error", reject)
      child.once("exit", () => resolvePid(child.pid!))
    })
    for (const [directory, pid] of [[live, process.pid], [dead, exited]] as const) {
      await mkdir(join(directory, "objects"), { recursive: true })
      await writeFile(join(directory, "domovoi-owner"), JSON.stringify({ pid, startedAt: "2026-09-30T00:00:00.000Z" }))
    }
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(live, old, old)

    await new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-sweep-owner")

    expect((await lstat(live)).isDirectory()).toBe(true)
    await expect(lstat(dead)).rejects.toThrow()
  })

  it("runs no repository core.fsmonitor command while it checks a session out", async () => {
    const { repositoryPath, payload, worktrees, git, ran } = await filteredRepository("domovoi-create-fsmonitor-")
    await git("config", "core.fsmonitor", `sh ${payload}`)
    await new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-fsmonitor")
    expect(await ran()).toBe(false)
  })

  // Settings that decide what the checkout writes are carried from the
  // repository's config into the isolated checkout.
  it("still applies the repository's core.autocrlf and core.symlinks to the files it checks out", async () => {
    const { repositoryPath, worktrees, git } = await filteredRepository("domovoi-create-core-settings-")
    await symlink("victim.txt", join(repositoryPath, "link.txt"))
    await git("add", ".")
    await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "link")
    await git("config", "core.autocrlf", "true")
    await git("config", "core.symlinks", "false")

    const workspace = await new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-core-settings")

    expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\r\n")
    expect((await lstat(join(workspace.path, "link.txt"))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(workspace.path, "link.txt"), "utf8")).toBe("victim.txt")
    expect((await run("-C", workspace.path, "status", "--porcelain")).stdout).toBe("")
  })

  it("checks out only what the repository's sparse checkout patterns name", async () => {
    const { repositoryPath, worktrees, git } = await filteredRepository("domovoi-create-sparse-")
    await git("sparse-checkout", "set", "--no-cone", "/victim.txt")

    const workspace = await new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-sparse")

    expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\n")
    await expect(lstat(join(workspace.path, ".gitattributes"))).rejects.toThrow()
    expect((await run("-C", workspace.path, "status", "--porcelain")).stdout).toBe("")
  })

  it("runs no filter the shared config defines after the scan, for a driver the commit's attributes select", async () => {
    const { repositoryPath, payload, worktrees, git, ran } = await filteredRepository("domovoi-create-race-")
    const service = new GitWorkspaceService(worktrees, {
      afterNewWorktreeScan: async () => { await git("config", "filter.agent.smudge", `sh ${payload}`) },
    })

    // The isolated checkout never reads the repository's config, so a driver
    // defined there after the scan runs nothing (ruling Q223).
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-race")

    expect(await ran()).toBe(false)
    expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\n")
  })

  it("runs no filter defined after the scan for a driver info/attributes selected at the scan", async () => {
    const { repositoryPath, payload, worktrees, git, ran } = await filteredRepository("domovoi-create-race-info-")
    const infoAttributes = join(repositoryPath, ".git", "info", "attributes")
    await mkdir(join(repositoryPath, ".git", "info"), { recursive: true })
    await writeFile(infoAttributes, "victim.txt filter=late\n")
    const service = new GitWorkspaceService(worktrees, {
      afterNewWorktreeScan: async () => { await git("config", "filter.late.smudge", `sh ${payload}`) },
    })

    await service.createSessionWorkspace(repositoryPath, "session-race-info")

    expect(await ran()).toBe(false)
  })

  it("reads attributes for the checkout from the commit, not from files planted in the new worktree", async () => {
    const { repositoryPath, payload, worktrees, git, ran } = await filteredRepository("domovoi-create-race-planted-")
    await mkdir(join(repositoryPath, "sub"))
    await writeFile(join(repositoryPath, "sub", "note.txt"), "note\n")
    await git("add", ".")
    await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "sub")
    const service = new GitWorkspaceService(worktrees, {
      afterNewWorktreeScan: async (path) => {
        await mkdir(join(path, "sub"))
        await writeFile(join(path, "sub", ".gitattributes"), "* filter=planted\n")
        await git("config", "filter.planted.smudge", `sh ${payload}`)
      },
    })

    const workspace = await service.createSessionWorkspace(repositoryPath, "session-race-planted")

    expect(await ran()).toBe(false)
    expect(await readFile(join(workspace.path, "sub", "note.txt"), "utf8")).toBe("note\n")
  })

  // What ruling Q221 A could only notice after the fact (info/attributes
  // rewritten to select a fresh driver the config then defines) no longer
  // runs at all: the isolated checkout reads neither.
  it("runs nothing when info/attributes and the config select and define a fresh driver during the checkout", async () => {
    const { scratch, repositoryPath, payload, worktrees, git, ran } = await filteredRepository("domovoi-create-changed-")
    const service = new GitWorkspaceService(worktrees, {
      afterNewWorktreeScan: async () => {
        await mkdir(join(repositoryPath, ".git", "info"), { recursive: true })
        await writeFile(join(repositoryPath, ".git", "info", "attributes"), "victim.txt filter=fresh\n")
        await writeFile(join(scratch, "planted-attributes"), "victim.txt filter=fresh\n")
        await git("config", "core.attributesFile", join(scratch, "planted-attributes"))
        await git("config", "filter.fresh.smudge", `sh ${payload}`)
      },
    })

    const workspace = await service.createSessionWorkspace(repositoryPath, "session-changed")

    expect(await ran()).toBe(false)
    expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\n")
  })

  it("checks out the commit it scanned even when the session branch moves after the scan", async () => {
    const { repositoryPath, worktrees, git } = await filteredRepository("domovoi-create-race-branch-")
    const scanned = (await git("rev-parse", "HEAD")).stdout.trim()
    await writeFile(join(repositoryPath, "victim.txt"), "moved\n")
    await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-am", "later")
    const later = (await git("rev-parse", "HEAD")).stdout.trim()
    await git("reset", "--hard", "-q", scanned)
    const service = new GitWorkspaceService(worktrees, {
      afterNewWorktreeScan: async () => { await git("update-ref", "refs/heads/domovoi/session-race-branch", later) },
    })

    const workspace = await service.createSessionWorkspace(repositoryPath, "session-race-branch")

    expect(workspace.baseCommit).toBe(scanned)
    expect((await run("-C", workspace.path, "rev-parse", "HEAD")).stdout.trim()).toBe(scanned)
    expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\n")
  })

  // The install lines alone are exempt; what they would make git-lfs start is not.
  it("refuses a session whose exempt Git LFS lines would start a transfer agent the repository names", async () => {
    const { repositoryPath, worktrees, git, branches } = await filteredRepository("domovoi-create-lfs-agent-")
    await git("config", "filter.lfs.process", "git-lfs filter-process")
    await git("config", "filter.lfs.smudge", "git-lfs smudge -- %f")
    await git("config", "lfs.customtransfer.evil.path", "/tmp/evil-agent")
    await git("config", "lfs.standalonetransferagent", "evil")

    await expect(new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-lfs")).rejects.toMatchObject({
      name: "RepositoryGitFilterRefusedError",
      drivers: [{ name: "evil", scope: "local" }],
      worktreeRemoved: true,
      message: expect.stringContaining("lfs.customtransfer.evil.path in local Git config"),
    })
    await expect(lstat(join(worktrees, "session-lfs"))).rejects.toThrow()
    expect(await branches()).toBe("")
  })

  it("says the new worktree stayed, and why, when it could not be taken away", async () => {
    const { repositoryPath, filterFile, worktrees, git, ran, branches } = await filteredRepository("domovoi-create-kept-")
    await git("config", "includeIf.onbranch:domovoi/**.path", filterFile)
    // A locked worktree survives one `worktree remove --force`.
    const service = new GitWorkspaceService(worktrees, {
      afterNewWorktreeScan: async (path) => { await git("worktree", "lock", path) },
    })

    const refused = service.createSessionWorkspace(repositoryPath, "session-kept")

    await expect(refused).rejects.toMatchObject({ name: "RepositoryGitFilterRefusedError", worktreeRemoved: false })
    const message = await refused.catch((error: Error) => error.message)
    expect(message).not.toContain("no worktree was left")
    expect(message).toContain("Nothing ran")
    expect(message).toContain("could not take the new worktree away")
    expect(message).toContain("kept for recovery")
    expect(await ran()).toBe(false)
    expect((await lstat(join(worktrees, "session-kept"))).isDirectory()).toBe(true)
    expect(await branches()).toBe("domovoi/session-kept")
  })

  it("says the branch remains, and not the worktree, when only the branch could not be deleted", async () => {
    const { repositoryPath, filterFile, worktrees, git, ran, branches } = await filteredRepository("domovoi-create-branch-kept-")
    await git("config", "includeIf.onbranch:domovoi/**.path", filterFile)
    // A lock file on the branch ref makes `branch -D` fail after the worktree is gone.
    const service = new GitWorkspaceService(worktrees, {
      afterNewWorktreeScan: async () => {
        await writeFile(join(repositoryPath, ".git", "refs", "heads", "domovoi", "session-branch-kept.lock"), "")
      },
    })

    const refused = service.createSessionWorkspace(repositoryPath, "session-branch-kept")

    await expect(refused).rejects.toMatchObject({ name: "RepositoryGitFilterRefusedError", worktreeRemoved: true, branchRemoved: false })
    const message = await refused.catch((error: Error) => error.message)
    expect(message).not.toContain("no worktree was left")
    expect(message).not.toContain("stays unchecked-out")
    expect(message).toContain("The new worktree was taken away, but its branch could not be deleted")
    expect(await ran()).toBe(false)
    await expect(lstat(join(worktrees, "session-branch-kept"))).rejects.toThrow()
    expect(await branches()).toBe("domovoi/session-branch-kept")
  })

  it("refuses a fork whose source worktree's own config sets a filter the fork would copy", async () => {
    const { repositoryPath, payload, worktrees, git, ran, branches } = await filteredRepository("domovoi-fork-filter-")
    const service = new GitWorkspaceService(worktrees)
    const source = await service.createSessionWorkspace(repositoryPath, "session-source")
    const checkpoint = await service.checkpoint(source.path, "before fork")
    await git("config", "extensions.worktreeConfig", "true")
    await run("-C", source.path, "config", "--worktree", "filter.agent.smudge", `sh ${payload}`)

    await expect(service.createSessionWorkspaceFromCheckpoint(source.path, checkpoint.commit, "session-fork")).rejects.toMatchObject({
      name: "RepositoryGitFilterRefusedError",
      drivers: [{ name: "agent", scope: "worktree" }],
      worktreeRemoved: true,
    })
    expect(await ran()).toBe(false)
    await expect(lstat(join(worktrees, "session-fork"))).rejects.toThrow()
    expect(await branches()).toBe("domovoi/session-source")
  })

  it("checks a session out in full when no repository filter is set, lfs install lines included", async () => {
    const { repositoryPath, worktrees, git, ran } = await filteredRepository("domovoi-create-clean-")
    await git("config", "filter.lfs.smudge", "git-lfs smudge -- %f")
    await git("config", "filter.lfs.process", "git-lfs filter-process")
    const service = new GitWorkspaceService(worktrees)

    const workspace = await service.createSessionWorkspace(repositoryPath, "session-clean")
    // The checkpoint reads the same lines as exempt too (P8 PR B), so it is
    // taken: nothing changed.
    const checkpoint = await service.checkpoint(workspace.path, "unchanged")

    expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\n")
    expect(await readFile(join(workspace.path, ".gitattributes"), "utf8")).toBe("victim.txt filter=agent\n")
    expect((await run("-C", workspace.path, "status", "--porcelain")).stdout).toBe("")
    expect(checkpoint).toEqual({ commit: workspace.baseCommit, changedFiles: [] })
    expect(await ran()).toBe(false)
    const fork = await service.createSessionWorkspaceFromCheckpoint(workspace.path, workspace.baseCommit, "session-clean-fork")
    expect(await readFile(join(fork.path, "victim.txt"), "utf8")).toBe("base\n")
  })

  it("still runs a filter the person set in their global Git config when it checks a session out", async () => {
    const { scratch, repositoryPath, payload, worktrees, ran } = await filteredRepository("domovoi-create-global-")
    const home = join(scratch, "home")
    await mkdir(home)
    await writeFile(join(home, ".gitconfig"), `[filter "agent"]\n\tsmudge = sh ${payload}\n`)
    const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")
    try {
      const workspace = await new GitWorkspaceService(worktrees).createSessionWorkspace(repositoryPath, "session-global")
      expect(await readFile(join(workspace.path, "victim.txt"), "utf8")).toBe("base\n")
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    expect(await ran()).toBe(true)
  })

  it("refuses to restore a transferred session where the target's config sets a filter for its branch", async () => {
    const { scratch, repositoryPath, filterFile, ran } = await filteredRepository("domovoi-transfer-filter-")
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "victim.txt"), "moved\n")
    await source.checkpoint(workspace.path, "before-transfer")
    const bundle = await source.bundleSession(workspace.path, join(scratch, "session.bundle"))
    const targetRepositoryPath = join(scratch, "target-project")
    await run("clone", "--quiet", repositoryPath, targetRepositoryPath)
    await run("-C", targetRepositoryPath, "config", "includeIf.onbranch:domovoi/**.path", filterFile)
    const targetWorktrees = join(scratch, "target-worktrees")
    const target = new GitWorkspaceService(targetWorktrees)

    await expect(target.restoreSessionFromBundle(bundle.path, "session-1", { repositoryPath: targetRepositoryPath })).rejects.toMatchObject({
      name: "RepositoryGitFilterRefusedError",
      drivers: [{ name: "agent", scope: "local" }],
      worktreeRemoved: true,
    })
    expect(await ran()).toBe(false)
    await expect(lstat(join(targetWorktrees, "session-1"))).rejects.toThrow()
    expect((await run("-C", targetRepositoryPath, "branch", "--list", "domovoi/*")).stdout.trim()).toBe("")
  })

  it("refuses to restore a session from a shared remote where the target's config sets a filter for its branch", async () => {
    const { scratch, repositoryPath, filterFile, git, ran } = await filteredRepository("domovoi-ref-transfer-filter-")
    const remotePath = join(scratch, "remote.git")
    await run("init", "--bare", remotePath)
    const served = await servedRemotes(scratch)
    await git("remote", "add", "origin", served.url("remote.git"))
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
    await writeFile(join(workspace.path, "victim.txt"), "moved\n")
    const checkpoint = await source.checkpoint(workspace.path, "before-transfer")
    await source.pushSessionRef(workspace.path, "origin", "session-1")
    const targetClone = join(scratch, "target-project")
    await run("clone", "--quiet", served.url("remote.git"), targetClone)
    await run("-C", targetClone, "config", "includeIf.onbranch:domovoi/**.path", filterFile)
    const targetWorktrees = join(scratch, "target-worktrees")

    await expect(new GitWorkspaceService(targetWorktrees).restoreSessionFromRef(targetClone, "origin", "session-1", checkpoint.commit))
      .rejects.toMatchObject({ name: "RepositoryGitFilterRefusedError", worktreeRemoved: true })
    expect(await ran()).toBe(false)
    await expect(lstat(join(targetWorktrees, "session-1"))).rejects.toThrow()
    expect((await run("-C", targetClone, "branch", "--list", "domovoi/*")).stdout.trim()).toBe("")
  })

  // The operations on a session worktree that already exists run every Git
  // command that can start a program through an isolated Git directory too
  // (ruling Q223 extended in P8 PR B): no repository config key starts
  // anything there, whether or not the repository is trusted.
  it.skipIf(!fakeLfsRuns).each([
    ["core.sshCommand", "ssh"], ["core.askPass", "askpass"], ["credential.helper", "helper"],
    ["credential.https://lfs.example.test.helper", "url-helper"], ["core.fsmonitor", "fsmonitor"],
  ])("runs no program the repository's %s names during checkpoint, restore and revert", async (key, label) => {
    const { repositoryPath, payload, git, ran, create, withLfs, worktrees } = await lfsRepository(`domovoi-ops-lfs-${label}-`)
    // Git LFS from the person's own config alone: the repository sets no filter.
    await git("config", "--unset", "filter.lfs.smudge")
    await git("config", "--unset", "filter.lfs.required")
    const workspace = await create(`session-ops-${label}`)
    await git("config", key, `sh ${payload}`)
    const service = new GitWorkspaceService(worktrees)

    await withLfs(async () => {
      await writeFile(join(workspace.path, "object.bin"), "changed\n")
      const checkpoint = await service.checkpoint(workspace.path, "lfs")
      await writeFile(join(workspace.path, "object.bin"), "later\n")
      await service.restore(workspace.path, checkpoint.commit)
      expect(await readFile(join(workspace.path, "object.bin"), "utf8")).toBe("changed\n")
      await writeFile(join(workspace.path, "object.bin"), "edited\n")
      await service.revertFile(workspace.path, "object.bin")
      await service.evidence(workspace.path)
    })

    expect(await ran()).toBe(false)
    expect(await readFile(join(workspace.path, "object.bin"), "utf8")).toBe("changed\n")
    expect(await readFile(join(repositoryPath, "object.bin"), "utf8")).toBe("object\n")
  })

  it.skipIf(!fakeLfsRuns)("runs no program the target repository's credential helper names when a bundle applies to a session it holds", async () => {
    const { scratch, repositoryPath, payload, git, ran, withLfs } = await lfsRepository("domovoi-ops-lfs-transfer-")
    await git("config", "--unset", "filter.lfs.smudge")
    await git("config", "--unset", "filter.lfs.required")
    const targetRepositoryPath = join(scratch, "target-project")
    await run("clone", "--quiet", repositoryPath, targetRepositoryPath)
    const source = new GitWorkspaceService(join(scratch, "source-worktrees"))
    const target = new GitWorkspaceService(join(scratch, "target-worktrees"))

    const updated = await withLfs(async () => {
      const workspace = await source.createSessionWorkspace(repositoryPath, "session-1")
      await writeFile(join(workspace.path, "object.bin"), "first\n")
      const first = await source.checkpoint(workspace.path, "first")
      const full = await source.bundleSession(workspace.path, join(scratch, "full.bundle"))
      await target.restoreSessionFromBundle(full.path, "session-1", { repositoryPath: targetRepositoryPath })
      await run("-C", targetRepositoryPath, "config", "credential.helper", `sh ${payload}`)
      await writeFile(join(workspace.path, "object.bin"), "second\n")
      await source.checkpoint(workspace.path, "second")
      const incremental = await source.bundleSession(workspace.path, join(scratch, "incremental.bundle"), first.commit)
      return target.restoreSessionFromBundle(incremental.path, "session-1", { repositoryPath: targetRepositoryPath })
    })

    expect(await readFile(join(updated.path, "object.bin"), "utf8")).toBe("second\n")
    expect((await run("-C", updated.path, "status", "--porcelain")).stdout).toBe("")
    expect(await ran()).toBe(false)
  })

  // The exact lines `git lfs install` writes are not a repository filter
  // (ruling Q207 A) for these operations either, as for a new session.
  it("checkpoints, restores and reverts a session whose repository config holds only the git lfs install lines", async () => {
    const { repositoryPath, worktrees, git, ran } = await filteredRepository("domovoi-ops-lfs-lines-")
    const service = new GitWorkspaceService(worktrees)
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-lfs-lines")
    await git("config", "filter.lfs.smudge", "git-lfs smudge -- %f")
    await git("config", "filter.lfs.process", "git-lfs filter-process")
    await git("config", "filter.lfs.required", "true")

    await writeFile(join(workspace.path, "note.txt"), "changed\n")
    const checkpoint = await service.checkpoint(workspace.path, "lfs lines")
    await writeFile(join(workspace.path, "note.txt"), "later\n")
    await service.restore(workspace.path, checkpoint.commit)
    await writeFile(join(workspace.path, "note.txt"), "edited\n")
    await service.revertFile(workspace.path, "note.txt")

    expect(await readFile(join(workspace.path, "note.txt"), "utf8")).toBe("changed\n")
    expect(await ran()).toBe(false)
  })

  // What the exempt lines would make git-lfs start is a repository filter here
  // as at checkout: the reader that decides both is the same.
  it("refuses a checkpoint while the repository names a Git LFS transfer agent", async () => {
    const { repositoryPath, worktrees, git } = await filteredRepository("domovoi-ops-lfs-agent-")
    const service = new GitWorkspaceService(worktrees)
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-lfs-agent")
    await git("config", "lfs.customtransfer.evil.path", "/tmp/evil-agent")
    await git("config", "lfs.standalonetransferagent", "evil")
    await writeFile(join(workspace.path, "note.txt"), "changed\n")

    await expect(service.checkpoint(workspace.path, "agent")).rejects.toMatchObject({
      name: "RepositoryFilterRefusedError",
      drivers: [{ name: "evil", scope: "local" }],
      message: expect.stringContaining("lfs.customtransfer.evil.path in local Git config"),
    })
  })

  // `worktree remove --force` runs no filter, so archive refuses nothing: a
  // session whose archive checkpoint was taken can always finish archiving,
  // for one after its repository's trust was revoked (P8 plan section 4).
  it("archives a session worktree while the repository's own config sets a filter, and runs nothing", async () => {
    const { repositoryPath, payload, worktrees, git, ran, branches } = await filteredRepository("domovoi-archive-filter-")
    const service = new GitWorkspaceService(worktrees)
    const workspace = await service.createSessionWorkspace(repositoryPath, "session-archive-filter")
    await git("config", "filter.agent.clean", `sh ${payload}`)
    await git("config", "filter.agent.smudge", `sh ${payload}`)
    await writeFile(join(workspace.path, "victim.txt"), "changed\n")

    await service.archiveSessionWorkspace(workspace.path)

    await expect(lstat(workspace.path)).rejects.toThrow()
    expect(await branches()).toBe("domovoi/session-archive-filter")
    expect(await ran()).toBe(false)
  })

  // A repository trusted on this machine (P8 PR B): its reviewed filter
  // definitions run, and only those. clean lowers the case and smudge raises
  // it, each noting that it ran.
  async function trustedRepository(prefix: string) {
    const repository = await filteredRepository(prefix)
    const { scratch, repositoryPath, git } = repository
    const marker = join(scratch, "trusted-ran").replaceAll("\\", "/")
    const script = (name: string, body: string) => {
      const path = join(scratch, `${name}.sh`).replaceAll("\\", "/")
      return writeFile(path, `echo ${name} >> "${marker}"\n${body}\n`).then(() => path)
    }
    const clean = await script("clean", "tr A-Z a-z")
    const smudge = await script("smudge", "tr a-z A-Z")
    const swapped = await script("swapped", "cat")
    await git("config", "filter.agent.clean", `sh ${clean}`)
    await git("config", "filter.agent.smudge", `sh ${smudge}`)
    const markers = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean)
    const state = { grant: undefined as RepositoryTrustGrant | undefined, generation: 0 }
    const projectId = "project-trusted"
    const trust = async () => {
      const config = await readRepositoryProviderConfig(repositoryPath, projectRootRead)
      expect(config.trustRefusals).toEqual([])
      state.grant = { projectId, trustedDigest: config.configDigest, trustedAt: "2026-09-30T12:00:00.000Z", trustedBy: { client: "desktop" } }
    }
    const revoke = () => {
      state.grant = undefined
      state.generation += 1
    }
    const service = (options: GitWorkspaceServiceOptions = {}) => new GitWorkspaceService(repository.worktrees, {
      ...options,
      repositoryTrust: () => ({ projectId, projectPath: repositoryPath, grant: () => state.grant, generation: () => state.generation }),
    })
    return { ...repository, marker, markers, swapped, trust, revoke, service, state, projectId }
  }

  const victimIn = (path: string) => readFile(join(path, "victim.txt"), "utf8")

  it("runs the reviewed filter once at create and at checkpoint, restore and revert under a matching grant", async () => {
    const { repositoryPath, markers, trust, service } = await trustedRepository("domovoi-trusted-run-")
    await trust()
    const trusted = service()

    const workspace = await trusted.createSessionWorkspace(repositoryPath, "session-trusted")
    expect(await victimIn(workspace.path)).toBe("BASE\n")
    expect(await markers()).toEqual(["smudge"])
    expect((await run("-C", workspace.path, "status", "--porcelain")).stdout).toBe("")

    await writeFile(join(workspace.path, "victim.txt"), "CHANGED\n")
    const checkpoint = await trusted.checkpoint(workspace.path, "trusted")
    expect((await run("-C", workspace.path, "show", `${checkpoint.commit}:victim.txt`)).stdout).toBe("changed\n")
    expect(await markers()).toContain("clean")

    await writeFile(join(workspace.path, "victim.txt"), "LATER\n")
    const smudgesBeforeRestore = (await markers()).filter((name) => name === "smudge").length
    await trusted.restore(workspace.path, workspace.baseCommit)
    expect(await victimIn(workspace.path)).toBe("BASE\n")
    expect((await markers()).filter((name) => name === "smudge").length).toBe(smudgesBeforeRestore + 1)

    await writeFile(join(workspace.path, "victim.txt"), "EDITED\n")
    await trusted.revertFile(workspace.path, "victim.txt")
    expect(await victimIn(workspace.path)).toBe("BASE\n")
    expect((await markers()).filter((name) => name === "smudge").length).toBe(smudgesBeforeRestore + 2)
  })

  it("refuses create when a reviewed filter's command changed after trust, and runs nothing", async () => {
    const { repositoryPath, worktrees, git, swapped, markers, trust, service, projectId, branches } = await trustedRepository("domovoi-trusted-changed-")
    await trust()
    await git("config", "filter.agent.smudge", `sh ${swapped}`)

    await expect(service().createSessionWorkspace(repositoryPath, "session-changed")).rejects.toMatchObject({
      name: "RepositoryGitFilterRefusedError",
      reason: "config-changed",
      projectId,
      drivers: [{ name: "agent", scope: "local" }],
      worktreeRemoved: true,
    })
    expect(await markers()).toEqual([])
    await expect(lstat(join(worktrees, "session-changed"))).rejects.toThrow()
    expect(await branches()).toBe("")
  })

  it("refuses filter operations once the agent configuration at the root changed after trust", async () => {
    const { repositoryPath, markers, trust, service } = await trustedRepository("domovoi-trusted-mcp-")
    await trust()
    const trusted = service()
    const workspace = await trusted.createSessionWorkspace(repositoryPath, "session-mcp")
    await writeFile(join(repositoryPath, ".mcp.json"), "{\"mcpServers\":{}}\n")
    await writeFile(join(workspace.path, "victim.txt"), "CHANGED\n")
    const before = await markers()

    await expect(trusted.checkpoint(workspace.path, "after mcp")).rejects.toMatchObject({ name: "RepositoryFilterRefusedError", reason: "config-changed" })
    await expect(trusted.restore(workspace.path, workspace.baseCommit)).rejects.toMatchObject({ reason: "config-changed" })
    await expect(trusted.revertFile(workspace.path, "victim.txt")).rejects.toMatchObject({ reason: "config-changed" })
    expect(await markers()).toEqual(before)
    expect(await victimIn(workspace.path)).toBe("CHANGED\n")
  })

  it("refuses under a grant when the session worktree reads other filters than the root", async () => {
    const { repositoryPath, git, swapped, markers, trust, service } = await trustedRepository("domovoi-trusted-worktree-")
    await trust()
    const trusted = service()
    const workspace = await trusted.createSessionWorkspace(repositoryPath, "session-worktree-config")
    await git("config", "extensions.worktreeConfig", "true")
    await run("-C", workspace.path, "config", "--worktree", "filter.agent.clean", `sh ${swapped}`)
    await writeFile(join(workspace.path, "victim.txt"), "CHANGED\n")
    const before = await markers()

    await expect(trusted.checkpoint(workspace.path, "worktree config")).rejects.toMatchObject({
      name: "RepositoryFilterRefusedError",
      reason: "config-changed",
      drivers: expect.arrayContaining([{ name: "agent", scope: "worktree" }]),
    })
    expect(await markers()).toEqual(before)
  })

  it("refuses a create under a grant when only the new session's branch includes another filter", async () => {
    const { scratch, repositoryPath, worktrees, git, swapped, markers, trust, service } = await trustedRepository("domovoi-trusted-onbranch-")
    const included = join(scratch, "extra.gitconfig")
    await writeFile(included, `[filter "extra"]\n\tsmudge = sh ${swapped}\n`)
    await git("config", "includeIf.onbranch:domovoi/**.path", included)
    await trust()

    await expect(service().createSessionWorkspace(repositoryPath, "session-onbranch")).rejects.toMatchObject({
      name: "RepositoryGitFilterRefusedError",
      reason: "config-changed",
      worktreeRemoved: true,
    })
    expect(await markers()).toEqual([])
    await expect(lstat(join(worktrees, "session-onbranch"))).rejects.toThrow()
  })

  it("runs the reviewed command when the config changes between the scan and the command", async () => {
    const { repositoryPath, git, swapped, markers, trust, service } = await trustedRepository("domovoi-trusted-swap-")
    await trust()
    const reviewedSmudge = (await git("config", "--get", "filter.agent.smudge")).stdout.trim()

    const workspace = await service({
      afterNewWorktreeScan: async () => { await git("config", "filter.agent.smudge", `sh ${swapped}`) },
    }).createSessionWorkspace(repositoryPath, "session-swap")
    expect(await victimIn(workspace.path)).toBe("BASE\n")
    expect(await markers()).toEqual(["smudge"])

    // The reviewed value again, so the digest is the trusted one, then a swap
    // between the checkpoint's gate and the staging it guards.
    await git("config", "filter.agent.smudge", reviewedSmudge)
    await writeFile(join(workspace.path, "victim.txt"), "CHANGED\n")
    const checkpoint = await service({
      afterRepositoryFilterGate: async () => { await git("config", "filter.agent.clean", `sh ${swapped}`) },
    }).checkpoint(workspace.path, "swap")

    expect((await run("-C", workspace.path, "show", `${checkpoint.commit}:victim.txt`)).stdout).toBe("changed\n")
    expect(await markers()).toContain("clean")
    expect(await markers()).not.toContain("swapped")
  })

  it("refuses a checkpoint after revoke, and leaves the files checked out under trust as they are", async () => {
    const { repositoryPath, markers, trust, revoke, service } = await trustedRepository("domovoi-trusted-revoke-")
    await trust()
    const trusted = service()
    const workspace = await trusted.createSessionWorkspace(repositoryPath, "session-revoke")
    revoke()
    await writeFile(join(workspace.path, "other.txt"), "agent work\n")
    const before = await markers()

    await expect(trusted.checkpoint(workspace.path, "after revoke")).rejects.toMatchObject({ name: "RepositoryFilterRefusedError", reason: "not-trusted" })
    expect(await markers()).toEqual(before)
    expect(await victimIn(workspace.path)).toBe("BASE\n")
    expect((await run("-C", workspace.path, "rev-parse", "HEAD")).stdout.trim()).toBe(workspace.baseCommit)
  })

  it("refuses when trust is revoked between the gate and the command it guards", async () => {
    const { repositoryPath, markers, trust, revoke, service } = await trustedRepository("domovoi-trusted-revoke-race-")
    await trust()
    const trusted = service({ afterRepositoryFilterGate: () => revoke() })
    const workspace = await service().createSessionWorkspace(repositoryPath, "session-revoke-race")
    await writeFile(join(workspace.path, "victim.txt"), "CHANGED\n")
    const before = await markers()

    await expect(trusted.checkpoint(workspace.path, "revoked meanwhile")).rejects.toMatchObject({ name: "RepositoryFilterRefusedError", reason: "not-trusted" })
    expect(await markers()).toEqual(before)
  })

  it("reads evidence through the reviewed clean filter under a grant, and with it treated as absent otherwise", async () => {
    const { repositoryPath, trust, revoke, service } = await trustedRepository("domovoi-trusted-evidence-")
    await trust()
    const trusted = service()
    const workspace = await trusted.createSessionWorkspace(repositoryPath, "session-evidence")
    // The same bytes again, so Git has to read the file to know it is unchanged.
    await writeFile(join(workspace.path, "victim.txt"), "BASE\n")
    const later = new Date(Date.now() + 5_000)
    await utimes(join(workspace.path, "victim.txt"), later, later)

    expect((await trusted.evidence(workspace.path)).files).toEqual([])

    revoke()
    const untrusted = await trusted.evidence(workspace.path)
    expect(untrusted.files.map((file) => file.path)).toEqual(["victim.txt"])
    expect(untrusted.diff).toContain("+BASE")
  })

  // Ruling Q219 A and the PR A leftover: a config Git cannot read holds every
  // filter back, and a grant made while it was unreadable pins no filter.
  it("keeps refusing while the repository's Git config cannot be read, under a grant made in that state", async () => {
    const { scratch, repositoryPath, git, markers, trust, service } = await trustedRepository("domovoi-trusted-unreadable-")
    await trust()
    const workspace = await service().createSessionWorkspace(repositoryPath, "session-unreadable")
    const before = await markers()
    const huge = join(scratch, "huge.gitconfig")
    await writeFile(huge, `[lfs]\n${"\tfetchexclude = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n".repeat(80_000)}`)
    await git("config", "include.path", huge)
    await trust()
    await writeFile(join(workspace.path, "victim.txt"), "changed\n")

    await expect(service().checkpoint(workspace.path, "unreadable")).rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", reason: "too-large" })
    expect(await markers()).toEqual(before)
  }, 30_000)

  // A filter under trust runs in its own process group, which a timeout or an
  // emergency stop ends whole (rulings Q102 A, Q104 A). POSIX only: Windows
  // has no process groups (ruling Q110 A).
  const processGroups = process.platform !== "win32"

  async function hangingRepository(prefix: string, operation: "process" | "smudge", escapes = false) {
    const repository = await trustedRepository(prefix)
    const { scratch, repositoryPath, git } = repository
    const pids = join(scratch, "pids").replaceAll("\\", "/")
    const escapedPids = join(scratch, "escaped-pids").replaceAll("\\", "/")
    const hang = join(scratch, "hang.sh").replaceAll("\\", "/")
    // An escaping filter first starts a child in a session of its own, which
    // leaves the filter's process group, as setsid does.
    const escape = join(scratch, "escape.mjs").replaceAll("\\", "/")
    await writeFile(escape, [
      "import { spawn } from \"node:child_process\"",
      "import { appendFileSync } from \"node:fs\"",
      "const child = spawn(process.execPath, [\"-e\", \"setTimeout(() => {}, 60000)\"], { detached: true, stdio: \"ignore\" })",
      "appendFileSync(process.argv[2], `${child.pid}\\n`)",
      "child.unref()",
      "",
    ].join("\n"))
    const escaping = escapes ? `"${process.execPath.replaceAll("\\", "/")}" "${escape}" "${escapedPids}"\n` : ""
    await writeFile(hang, `${escaping}echo $$ >> "${pids}"\nsleep 60 &\necho $! >> "${pids}"\nwait\n`)
    await writeFile(join(repositoryPath, ".gitattributes"), "victim.txt filter=agent\n*.hang filter=hang\n")
    if (operation === "smudge") await writeFile(join(repositoryPath, "stuck.hang"), "stuck\n")
    await git("add", ".")
    await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "hang")
    await git("config", `filter.hang.${operation}`, `sh ${hang}`)
    const pidList = async () => (await readFile(pids, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number)
    const waitForPids = async () => {
      for (let attempt = 0; attempt < 200 && (await pidList()).length < 2; attempt += 1) await new Promise((wait) => setTimeout(wait, 25))
      return pidList()
    }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const allGone = async (list: number[]) => {
      for (let attempt = 0; attempt < 200 && list.some(alive); attempt += 1) await new Promise((wait) => setTimeout(wait, 25))
      return !list.some(alive)
    }
    const escaped = async () => (await readFile(escapedPids, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number)
    return { ...repository, waitForPids, allGone, alive, escaped }
  }

  it.skipIf(!processGroups)("ends a hanging trusted process driver and every process it started when the operation times out", async () => {
    const { repositoryPath, trust, service, waitForPids, allGone } = await hangingRepository("domovoi-trusted-hang-", "process")
    await trust()
    const trusted = service()
    const workspace = await trusted.createSessionWorkspace(repositoryPath, "session-hang")
    await writeFile(join(workspace.path, "work.hang"), "agent work\n")
    const controller = new AbortController()

    const checkpoint = trusted.checkpoint(workspace.path, "hang", controller.signal)
    const outcome = checkpoint.then(() => undefined, (error: unknown) => error)
    const pids = await waitForPids()
    expect(pids).toHaveLength(2)
    controller.abort(new Error("Checkpoint timed out"))

    expect(await outcome).toBeInstanceOf(Error)
    expect(await allGone(pids)).toBe(true)
  }, 30_000)

  // An emptied process group does not prove that every process a filter
  // started has ended: one can leave the group (setsid). So after a kill the
  // checkout's descendants are unknown (fail closed, as ruling Q111 B), the
  // half-checked-out worktree is kept for recovery rather than deleted under
  // a writer that may still run, and the restore claim stays for inspection.
  it.skipIf(!processGroups).each([
    ["a filter that stays in its group", false],
    ["a filter that starts a child outside its group", true],
  ] as const)("keeps the worktree for recovery when an emergency stop lands during a trusted create: %s", async (_label, escapes) => {
    const { repositoryPath, worktrees, trust, service, waitForPids, allGone, alive, escaped, branches } = await hangingRepository(`domovoi-trusted-stop-${escapes ? "escape" : "group"}-`, "smudge", escapes)
    await trust()
    const controller = new AbortController()
    const left: number[] = []
    try {
      const creating = service().createSessionWorkspace(repositoryPath, "session-stop", controller.signal)
      const outcome = creating.then(() => undefined, (error: unknown) => error)
      const pids = await waitForPids()
      expect(pids).toHaveLength(2)
      left.push(...await escaped())
      expect(left).toHaveLength(escapes ? 1 : 0)
      controller.abort(new Error("Operation cancelled by emergency stop"))

      const error = await outcome as AggregateError
      expect(error).toMatchObject({ name: "SessionRestoreClaimCleanupError", message: expect.stringContaining("kept for recovery") })
      expect(error.errors.some((cause) => cause instanceof Error && cause.message.includes("descendant liveness is unknown"))).toBe(true)
      expect(await allGone(pids)).toBe(true)
      // The escaped child outlives the kill: this is what the claim guards.
      expect(left.every(alive)).toBe(true)
      expect((await lstat(join(worktrees, "session-stop"))).isDirectory()).toBe(true)
      expect(await branches()).toBe("domovoi/session-stop")
      expect((await lstat(join(worktrees, ".restore-claims", "session-stop"))).isFile()).toBe(true)
    } finally {
      for (const pid of left) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // Already gone.
        }
      }
    }
  }, 30_000)
})
