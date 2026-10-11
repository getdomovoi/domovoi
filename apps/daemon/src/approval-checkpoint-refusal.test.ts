import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { approvalCheckpointRefusal } from "./approval-checkpoint-refusal.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { GitWorkspaceService } from "./workspace.js"

// What the daemon can vouch for when the checkpoint before an approved
// command fails, read from real Git failures where the test can make one.

const execute = promisify(execFile)
const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories)
})

async function repository(name = "project") {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-checkpoint-refusal-"))
  scratchDirectories.push(scratch)
  const path = join(scratch, name)
  await execute("git", ["init", "--initial-branch=main", path])
  await writeFile(join(path, "file.txt"), "base\n")
  await execute("git", ["-C", path, "add", "file.txt"])
  await execute("git", ["-C", path, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"])
  return { scratch, path }
}

// The error a real Git command gives, as the workspace's git runs see it.
async function gitFailure(path: string, ...arguments_: string[]): Promise<unknown> {
  try {
    await execute("git", ["-C", path, ...arguments_])
  } catch (error) {
    return error
  }
  throw new Error(`git ${arguments_.join(" ")} did not fail`)
}

const stderrOf = (error: unknown) => String((error as { stderr?: unknown }).stderr)
const lockIn = (error: unknown) => /'([^']+\.lock)'/u.exec(stderrOf(error))?.[1]

describe("approvalCheckpointRefusal", () => {
  it("names a held index lock by the path Git reported", async () => {
    const { path } = await repository()
    await writeFile(join(path, ".git", "index.lock"), "")
    await writeFile(join(path, "file.txt"), "changed\n")
    const error = await gitFailure(path, "add", "file.txt")
    const lockPath = lockIn(error)
    expect(lockPath).toMatch(/[\\/]\.git[\\/]index\.lock$/u)
    expect(await approvalCheckpointRefusal(error, { timedOut: false, worktree: path })).toEqual({
      message: `Domovoi could not take a checkpoint: ${lockPath} is held by another git process, or was left by one that stopped, so the command did not run; decide again`,
      data: { kind: "approval-checkpoint-refused", cause: "lock-held", lockPath },
    })
  })

  it("names a held ref lock in a session worktree's shared Git directory", async () => {
    const { scratch, path: repositoryPath } = await repository()
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const { path: worktree } = await service.createSessionWorkspace(repositoryPath, "session-lock")
    await mkdir(join(repositoryPath, ".git", "refs", "domovoi", "checkpoints"), { recursive: true })
    await writeFile(join(repositoryPath, ".git", "refs", "domovoi", "checkpoints", "held.lock"), "")
    const error = await gitFailure(worktree, "update-ref", "refs/domovoi/checkpoints/held", "HEAD")
    const lockPath = lockIn(error)
    expect(lockPath).toBeDefined()
    expect((await approvalCheckpointRefusal(error, { timedOut: false, worktree })).data)
      .toEqual({ kind: "approval-checkpoint-refused", cause: "lock-held", lockPath })
  })

  // A filter the checkpoint runs can print anything, Git's lock sentence
  // included. A lock outside the worktree's Git directories is not Git's own.
  it("calls a lock outside the worktree's Git directories a Git failure", async () => {
    const { scratch, path } = await repository()
    const elsewhere = join(await realpath(scratch), "elsewhere.lock")
    await writeFile(elsewhere, "")
    const stderr = `fatal: Unable to create '${elsewhere}': File exists.\n`
    const error = Object.assign(new Error(stderr), { code: 128, stderr })
    expect(await approvalCheckpointRefusal(error, { timedOut: false, worktree: path })).toEqual({
      message: "Domovoi could not take a checkpoint because a Git command failed, so the command did not run; decide again",
      data: { kind: "approval-checkpoint-refused", cause: "git-failed" },
    })
  })

  // The path reaches every client, so a path the inventory redactor would
  // change is not sent: the refusal says only that Git failed.
  it("does not send a lock path the redactor would change", async () => {
    const { path } = await repository(`ghp_${"a".repeat(36)}`)
    await writeFile(join(path, ".git", "index.lock"), "")
    await writeFile(join(path, "file.txt"), "changed\n")
    const error = await gitFailure(path, "add", "file.txt")
    expect(lockIn(error)).toBeDefined()
    const answer = await approvalCheckpointRefusal(error, { timedOut: false, worktree: path })
    expect(answer.data).toEqual({ kind: "approval-checkpoint-refused", cause: "git-failed" })
    expect(answer.message).not.toContain("ghp_")
  })

  it("says Git is missing when the workspace cannot start it", async () => {
    const { scratch, path: repositoryPath } = await repository()
    const service = new GitWorkspaceService(join(scratch, "worktrees"))
    const { path: worktree } = await service.createSessionWorkspace(repositoryPath, "session-no-git")
    const empty = await mkdtemp(join(tmpdir(), "domovoi-no-git-"))
    scratchDirectories.push(empty)
    const saved = process.env.PATH
    let error: unknown
    process.env.PATH = empty
    try {
      await service.snapshot(worktree, "before approved command")
    } catch (failure) {
      error = failure
    } finally {
      process.env.PATH = saved
    }
    expect(error).toBeDefined()
    const answer = await approvalCheckpointRefusal(error, { timedOut: false, worktree })
    expect(answer.data).toEqual({ kind: "approval-checkpoint-refused", cause: "git-unavailable" })
    expect(answer.message).toMatch(/^Domovoi could not take a checkpoint, so the command did not run; decide again\. Domovoi found no git/u)
  })
})
