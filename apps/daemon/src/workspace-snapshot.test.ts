import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"
import { GitWorkspaceService, RepositoryFilterRefusedError } from "./workspace.js"

const execute = promisify(execFile)
const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories)
})

async function gitOut(path: string, ...arguments_: string[]): Promise<string> {
  return (await execute("git", ["-C", path, ...arguments_])).stdout
}

// A session worktree with work under way: a tracked file changed, one
// deleted, one staged by the person, an untracked file, a file named only
// with whitespace, an ignored file, and a file tracked despite the ignore.
async function worktreeWithWork() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-snapshot-"))
  scratchDirectories.push(scratch)
  const repositoryPath = join(scratch, "project")
  await execute("git", ["init", "--initial-branch=main", repositoryPath])
  await execute("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"])
  await writeFile(join(repositoryPath, "tracked.txt"), "base\n")
  await writeFile(join(repositoryPath, "doomed.txt"), "going\n")
  await writeFile(join(repositoryPath, "staged.txt"), "base\n")
  await writeFile(join(repositoryPath, ".gitignore"), "build/\n")
  await execute("mkdir", [join(repositoryPath, "build")])
  await writeFile(join(repositoryPath, "build", "keep.js"), "tracked despite the ignore rule\n")
  await execute("git", ["-C", repositoryPath, "add", "."])
  await execute("git", ["-C", repositoryPath, "add", "--force", "build/keep.js"])
  await execute("git", [
    "-C", repositoryPath, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
    "commit", "-m", "initial",
  ])
  const service = new GitWorkspaceService(join(scratch, "worktrees"))
  const workspace = await service.createSessionWorkspace(repositoryPath, "session-snapshot")
  const path = workspace.path
  await writeFile(join(path, "tracked.txt"), "agent edit\n")
  await rm(join(path, "doomed.txt"))
  await writeFile(join(path, "staged.txt"), "person staged\n")
  await execute("git", ["-C", path, "add", "staged.txt"])
  await writeFile(join(path, "staged.txt"), "person staged, then edited\n")
  await writeFile(join(path, "new.txt"), "untracked\n")
  await writeFile(join(path, " "), "whitespace name\n")
  await writeFile(join(path, "build", "out.js"), "ignored\n")
  return { service, path, repositoryPath }
}

async function observe(path: string) {
  const indexPath = (await gitOut(path, "rev-parse", "--path-format=absolute", "--git-path", "index")).trim()
  return {
    head: (await gitOut(path, "rev-parse", "HEAD")).trim(),
    branch: (await gitOut(path, "symbolic-ref", "HEAD")).trim(),
    index: await readFile(indexPath),
    status: await gitOut(path, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    stagedDiff: await gitOut(path, "diff", "--cached"),
    files: Object.fromEntries(await Promise.all(["tracked.txt", "staged.txt", "new.txt", " "].map(
      async (name) => [name, await readFile(join(path, name), "utf8")] as const,
    ))),
    gitDirectory: (await readdir((await gitOut(path, "rev-parse", "--absolute-git-dir")).trim())).sort(),
  }
}

describe("GitWorkspaceService.snapshot", () => {
  it("records the worktree as a checkpoint without touching HEAD, the index or any file", async () => {
    const { service, path } = await worktreeWithWork()
    const before = await observe(path)

    const snapshot = await service.snapshot(path, "before approved command")

    expect(await observe(path)).toEqual(before)
    expect(snapshot.commit).toMatch(/^[a-f0-9]{40}$/u)
    expect(snapshot.commit).not.toBe(before.head)
    expect((await gitOut(path, "rev-parse", `refs/domovoi/checkpoints/${snapshot.commit}^{commit}`)).trim()).toBe(snapshot.commit)
    expect((await gitOut(path, "rev-parse", `${snapshot.commit}^`)).trim()).toBe(before.head)
    expect(await gitOut(path, "log", "-1", "--format=%s", snapshot.commit)).toBe("chore(domovoi): checkpoint before approved command\n")
    expect([...snapshot.changedFiles].sort()).toEqual([" ", "doomed.txt", "new.txt", "staged.txt", "tracked.txt"])
    const files = (await gitOut(path, "ls-tree", "-r", "-z", "--name-only", snapshot.commit)).split("\0").filter(Boolean).sort()
    expect(files).toEqual([" ", ".gitignore", "build/keep.js", "new.txt", "staged.txt", "tracked.txt"])
    expect(await gitOut(path, "show", `${snapshot.commit}:staged.txt`)).toBe("person staged, then edited\n")
    expect(await gitOut(path, "show", `${snapshot.commit}: `)).toBe("whitespace name\n")
  })

  it("restores the worktree to what the snapshot recorded", async () => {
    const { service, path } = await worktreeWithWork()
    const snapshot = await service.snapshot(path, "before approved command")
    await writeFile(join(path, "tracked.txt"), "the command broke this\n")
    await rm(join(path, " "))
    await writeFile(join(path, "new.txt"), "overwritten\n")

    await service.restore(path, snapshot.commit)

    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("agent edit\n")
    expect(await readFile(join(path, " "), "utf8")).toBe("whitespace name\n")
    expect(await readFile(join(path, "new.txt"), "utf8")).toBe("untracked\n")
    expect(await readFile(join(path, "staged.txt"), "utf8")).toBe("person staged, then edited\n")
    await expect(readFile(join(path, "doomed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("names HEAD when nothing changed, and still records it as a checkpoint", async () => {
    const { service, path } = await worktreeWithWork()
    await execute("git", ["-C", path, "add", "--all"])
    await execute("git", [
      "-C", path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "clean",
    ])
    const head = (await gitOut(path, "rev-parse", "HEAD")).trim()

    const snapshot = await service.snapshot(path, "before approved command")

    expect(snapshot).toEqual({ commit: head, changedFiles: [] })
    expect((await gitOut(path, "rev-parse", `refs/domovoi/checkpoints/${head}^{commit}`)).trim()).toBe(head)
  })

  it("records past a signing setup it cannot use", async () => {
    const { service, path, repositoryPath } = await worktreeWithWork()
    await execute("git", ["-C", repositoryPath, "config", "commit.gpgsign", "true"])
    await execute("git", ["-C", repositoryPath, "config", "gpg.program", join(repositoryPath, "missing-signer")])

    const snapshot = await service.snapshot(path, "before approved command")

    expect(await gitOut(path, "cat-file", "commit", snapshot.commit)).not.toContain("gpgsig")
  })

  it("refuses while the repository's own config sets a filter, and leaves no temporary index", async () => {
    const { service, path, repositoryPath } = await worktreeWithWork()
    await execute("git", ["-C", repositoryPath, "config", "filter.agent.clean", "cat"])
    const before = await observe(path)

    await expect(service.snapshot(path, "before approved command")).rejects.toBeInstanceOf(RepositoryFilterRefusedError)

    expect(await observe(path)).toEqual(before)
  })

  it("records what was staged against the HEAD it started from, when the agent commits meanwhile", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-snapshot-race-"))
    scratchDirectories.push(scratch)
    const path = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", path])
    await writeFile(join(path, "tracked.txt"), "base\n")
    await execute("git", ["-C", path, "add", "."])
    await execute("git", ["-C", path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"])
    const started = (await gitOut(path, "rev-parse", "HEAD")).trim()
    await writeFile(join(path, "tracked.txt"), "agent edit\n")
    const service = new GitWorkspaceService(join(scratch, "worktrees"), {
      // The agent commits its edit after the snapshot staged it.
      afterCheckpointStaging: async () => {
        await execute("git", ["-C", path, "-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "-am", "agent"])
      },
    })

    const snapshot = await service.snapshot(path, "before approved command")

    expect(snapshot.commit).not.toBe(started)
    expect((await gitOut(path, "rev-parse", `${snapshot.commit}^`)).trim()).toBe(started)
    expect(await gitOut(path, "show", `${snapshot.commit}:tracked.txt`)).toBe("agent edit\n")
    expect(snapshot.changedFiles).toEqual(["tracked.txt"])
  })

  it("records a repository with no commit yet as a root commit", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-snapshot-unborn-"))
    scratchDirectories.push(scratch)
    const path = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", path])
    await writeFile(join(path, "first.txt"), "first\n")
    await writeFile(join(path, " "), "whitespace name\n")

    const snapshot = await new GitWorkspaceService(join(scratch, "worktrees")).snapshot(path, "before approved command")

    expect([...snapshot.changedFiles].sort()).toEqual([" ", "first.txt"])
    expect((await gitOut(path, "rev-list", "--parents", "-n", "1", snapshot.commit)).trim()).toBe(snapshot.commit)
    await expect(gitOut(path, "rev-parse", "--verify", "-q", "HEAD")).rejects.toThrow()
    expect(await gitOut(path, "status", "--porcelain")).toBe("?? \" \"\n?? first.txt\n")
  })
})
