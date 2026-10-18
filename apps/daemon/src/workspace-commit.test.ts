import { execFile } from "node:child_process"
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"
import { GitWorkspaceService, SessionCommitRefusedError, type GitWorkspaceServiceOptions } from "./workspace.js"

// Walk finding F10 (ruled 2026-10-18): the agent's sandbox cannot write a
// linked worktree's Git metadata, so Domovoi commits the session's work when
// a person asks. It commits on the session branch and nowhere else, through
// the isolated Git directory checkpoints use (no repository hook, no program
// from repository config), and refuses a file that looks like a secret.

const execute = promisify(execFile)
const scratchDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await removeScratchDirectories(scratchDirectories)
})

const person = ["-c", "user.name=Test User", "-c", "user.email=test@example.invalid"]
const git = async (path: string, ...args: string[]) => (await execute("git", ["-C", path, ...person, ...args])).stdout.trim()

async function sessionWorktree(prefix: string, sessionId = "session-commit", options: GitWorkspaceServiceOptions = {}) {
  const scratch = await mkdtemp(join(tmpdir(), prefix))
  scratchDirectories.push(scratch)
  const repositoryPath = join(scratch, "project")
  await execute("git", ["init", "--initial-branch=main", repositoryPath])
  await git(repositoryPath, "config", "core.autocrlf", "false")
  await writeFile(join(repositoryPath, "README.md"), "before\n")
  await writeFile(join(repositoryPath, "old.txt"), "old\n")
  await writeFile(join(repositoryPath, ".gitignore"), "ignored.log\n")
  await git(repositoryPath, "add", ".")
  await git(repositoryPath, "commit", "-m", "initial")
  const service = new GitWorkspaceService(join(scratch, "worktrees"), options)
  const workspace = await service.createSessionWorkspace(repositoryPath, sessionId)
  return { scratch, repositoryPath, service, workspace, sessionId }
}

async function refusal(promise: Promise<unknown>): Promise<SessionCommitRefusedError> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(SessionCommitRefusedError)
  return error as SessionCommitRefusedError
}

describe("GitWorkspaceService.commit", () => {
  it("commits every change in the worktree on the session branch with the person's message", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-")
    await git(repositoryPath, "config", "user.name", "Dana Person")
    await git(repositoryPath, "config", "user.email", "dana@example.invalid")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    await writeFile(join(workspace.path, "new.txt"), "new\n")
    await writeFile(join(workspace.path, "ignored.log"), "never committed\n")
    await rm(join(workspace.path, "old.txt"))
    const mainBefore = await git(repositoryPath, "rev-parse", "main")

    const made = await service.commit(workspace.path, {
      repositoryPath, sessionId, message: "feat(readme): say after\n\nThe body stays.", expectedHead: workspace.baseCommit,
    })

    expect(made.branch).toBe(`domovoi/${sessionId}`)
    expect(made.commit).toMatch(/^[a-f0-9]{40}$/u)
    expect(made.changedFiles).toEqual(["README.md", "new.txt", "old.txt"])
    expect(await git(workspace.path, "rev-parse", `refs/heads/domovoi/${sessionId}`)).toBe(made.commit)
    expect(await git(workspace.path, "rev-parse", `${made.commit}^`)).toBe(workspace.baseCommit)
    expect(await git(workspace.path, "log", "-1", "--format=%B", made.commit)).toBe("feat(readme): say after\n\nThe body stays.")
    // The person is the author, as the design draws it; Domovoi made it.
    expect(await git(workspace.path, "log", "-1", "--format=%an <%ae>|%cn <%ce>", made.commit))
      .toBe("Dana Person <dana@example.invalid>|Domovoi <domovoi@localhost>")
    expect(await git(workspace.path, "cat-file", "commit", made.commit)).not.toContain("gpgsig")
    expect(await git(workspace.path, "show", `${made.commit}:README.md`)).toBe("after")
    await expect(git(workspace.path, "show", `${made.commit}:ignored.log`)).rejects.toThrow()
    // The commit restores and transfers like a checkpoint.
    expect(await git(workspace.path, "rev-parse", `refs/domovoi/checkpoints/${made.commit}^{commit}`)).toBe(made.commit)
    // The worktree reads as clean afterwards, but for the ignored file.
    expect(await git(workspace.path, "status", "--porcelain")).toBe("")
    // No other branch moved and the person's own checkout was not written.
    expect(await git(repositoryPath, "rev-parse", "main")).toBe(mainBefore)
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("before\n")
  })

  it("refuses with nothing written when the worktree is on another branch", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-branch-")
    await git(workspace.path, "switch", "-q", "-c", "elsewhere")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const mainBefore = await git(repositoryPath, "rev-parse", "main")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("not-session-branch")
    expect(error.message).toContain(`domovoi/${sessionId}`)
    expect(await git(workspace.path, "rev-parse", "elsewhere")).toBe(workspace.baseCommit)
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
    expect(await git(repositoryPath, "rev-parse", "main")).toBe(mainBefore)
    expect(await git(workspace.path, "status", "--porcelain")).toBe("M README.md")
  })

  it("refuses a detached HEAD", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-detached-")
    await git(workspace.path, "switch", "-q", "--detach")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("not-session-branch")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it("refuses when the session branch moved since the person read the changes", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-moved-")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const moved = (await service.checkpoint(workspace.path, "in between")).commit
    await writeFile(join(workspace.path, "README.md"), "later\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("head-moved")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(moved)
  })

  it("refuses a worktree that is not this session's own", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-other-")
    const other = await service.createSessionWorkspace(repositoryPath, "session-other")
    await writeFile(join(other.path, "README.md"), "after\n")
    await writeFile(join(repositoryPath, "README.md"), "after\n")

    // Another session's worktree under this session's id.
    expect((await refusal(service.commit(other.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))).reason)
      .toBe("not-session-worktree")
    // The person's own checkout, as an adopted session would record it.
    expect((await refusal(service.commit(repositoryPath, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))).reason)
      .toBe("not-session-worktree")
    expect(await git(repositoryPath, "rev-parse", "main")).toBe(workspace.baseCommit)
    expect(await git(repositoryPath, "rev-parse", "domovoi/session-other")).toBe(other.baseCommit)
  })

  it("refuses a session ref that points at another branch, and never moves that branch", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-symref-")
    await git(repositoryPath, "branch", "elsewhere", workspace.baseCommit)
    // HEAD still names the session ref, and the ref resolves to expectedHead,
    // but through elsewhere: a plain update-ref would move elsewhere.
    await git(workspace.path, "symbolic-ref", `refs/heads/domovoi/${sessionId}`, "refs/heads/elsewhere")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("not-session-branch")
    expect(await git(repositoryPath, "rev-parse", "refs/heads/elsewhere")).toBe(workspace.baseCommit)
  })

  it("refuses a checkout at the session's path that is not a worktree of the session's repository", async () => {
    const { scratch, repositoryPath, service } = await sessionWorktree("domovoi-commit-clone-")
    // An ordinary clone where the session's worktree would be, on the branch
    // a session worktree would be on.
    const sessionId = "session-clone"
    const path = join(scratch, "worktrees", sessionId)
    await execute("git", ["clone", "-q", repositoryPath, path])
    await git(path, "switch", "-q", "-c", `domovoi/${sessionId}`)
    const head = await git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "README.md"), "after\n")

    // Against the repository it was cloned from, and against itself.
    for (const project of [repositoryPath, path]) {
      const error = await refusal(service.commit(path, { repositoryPath: project, sessionId, message: "feat: x", expectedHead: head }))
      expect(error.reason).toBe("not-session-worktree")
    }
    expect(await git(path, "rev-parse", `domovoi/${sessionId}`)).toBe(head)
  })

  it("keeps the commit's checkpoint ref from carrying it onto another branch", async () => {
    // Fixed dates make the commit's id the same on a second try.
    vi.stubEnv("GIT_AUTHOR_DATE", "2026-10-18T12:00:00Z")
    vi.stubEnv("GIT_COMMITTER_DATE", "2026-10-18T12:00:00Z")
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-checkpoint-symref-")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const request = { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }
    const first = await service.commit(workspace.path, request)
    // Back to the start with the same files, and the ref the same commit
    // will be retained under made a symbolic ref to another branch.
    await git(workspace.path, "update-ref", `refs/heads/domovoi/${sessionId}`, workspace.baseCommit)
    await git(workspace.path, "read-tree", workspace.baseCommit)
    await git(repositoryPath, "branch", "elsewhere", workspace.baseCommit)
    await git(repositoryPath, "update-ref", "-d", `refs/domovoi/checkpoints/${first.commit}`)
    await git(repositoryPath, "symbolic-ref", `refs/domovoi/checkpoints/${first.commit}`, "refs/heads/elsewhere")

    const second = await service.commit(workspace.path, request)

    expect(second.commit).toBe(first.commit)
    expect(await git(repositoryPath, "rev-parse", "refs/heads/elsewhere")).toBe(workspace.baseCommit)
  })

  it("refuses a worktree whose .git is a link to another worktree's", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-git-link-")
    const other = await service.createSessionWorkspace(repositoryPath, "session-other")
    // The other worktree takes the session branch, which the session's own
    // worktree gives up first, and the session's .git then points at it.
    await git(workspace.path, "switch", "-q", "--detach")
    await git(other.path, "switch", "-q", `domovoi/${sessionId}`)
    await rm(join(workspace.path, ".git"))
    await symlink(join(other.path, ".git"), join(workspace.path, ".git"))
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const otherIndex = await git(other.path, "ls-files", "--stage")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("not-session-worktree")
    expect(await git(other.path, "ls-files", "--stage")).toBe(otherIndex)
  })

  it("leaves the index alone when the worktree switches branch while Domovoi commits", async () => {
    let worktree = ""
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-switch-", "session-commit", {
      // A switch to another branch at the same start: the index Git keeps
      // for it is the one Domovoi read, so only HEAD tells them apart.
      afterSessionCommit: async () => { await git(worktree, "switch", "-q", "-c", "other", "HEAD~1") },
    })
    worktree = workspace.path
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const indexBefore = await git(workspace.path, "ls-files", "--stage")

    const made = await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit })

    expect(made.afterCommitError).toContain("left domovoi/session-commit")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(made.commit)
    expect(await git(workspace.path, "symbolic-ref", "HEAD")).toBe("refs/heads/other")
    expect(await git(workspace.path, "ls-files", "--stage")).toBe(indexBefore)
  })

  it("does not name a secret-named submodule it refuses for its own config", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-secret-submodule-")
    const submodule = join(workspace.path, "private", ".env")
    await execute("git", ["init", "-q", "--initial-branch=main", submodule])
    await writeFile(join(submodule, "keys.txt"), "k\n")
    await git(submodule, "add", ".")
    await git(submodule, "commit", "-q", "-m", "keys")
    await git(submodule, "config", "remote.origin.promisor", "true")
    await git(workspace.path, "update-index", "--add", "--cacheinfo", `160000,${await git(submodule, "rev-parse", "HEAD")},private/.env`)

    const error = await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit })
      .then(() => undefined, (cause: unknown) => cause as Error)

    expect(error).toBeInstanceOf(Error)
    expect(error!.message).not.toContain(".env")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it("checks a secret-named submodule entry that the repository asks Git to ignore", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-ignored-submodule-")
    await writeFile(join(workspace.path, ".gitmodules"), "[submodule \"keys\"]\n\tpath = id_rsa\n\turl = ./keys\n\tignore = all\n")
    await git(workspace.path, "add", ".gitmodules")
    await git(workspace.path, "update-index", "--add", "--cacheinfo", `160000,${workspace.baseCommit},id_rsa`)
    // An unpopulated submodule: staging keeps its entry, and a plain diff,
    // told to ignore it, does not list it.
    await mkdir(join(workspace.path, "id_rsa"))
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("secret-paths")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it.each([
    [".env", "API_KEY=1\n"],
    ["config/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n"],
    ["deploy/server.pem", "-----BEGIN CERTIFICATE-----\n"],
  ])("refuses the whole commit when %s would enter it, and never names the file", async (path, contents) => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-secret-")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    await mkdir(join(workspace.path, path, ".."), { recursive: true })
    await writeFile(join(workspace.path, path), contents)
    const indexBefore = await git(workspace.path, "ls-files", "--stage")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("secret-paths")
    expect(error.message).toContain("1 file")
    expect(error.message).not.toContain(path.split("/").at(-1)!)
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
    expect(await git(workspace.path, "ls-files", "--stage")).toBe(indexBefore)
    await expect(readFile(join(workspace.path, path), "utf8")).resolves.toBe(contents)
  })

  it("refuses a message that holds a secret, which would stay in the branch's history", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-secret-message-")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, {
      repositoryPath, sessionId, message: "chore: rotate\n\nNPM_TOKEN=message-secret-fixture", expectedHead: workspace.baseCommit,
    }))

    expect(error.reason).toBe("secret-message")
    expect(error.message).not.toContain("message-secret-fixture")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it("lets a commit delete a secret file the branch already tracked", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-delete-secret-")
    await writeFile(join(workspace.path, ".env"), "API_KEY=1\n")
    await service.checkpoint(workspace.path, "tracked a secret")
    const head = await git(workspace.path, "rev-parse", "HEAD")
    await rm(join(workspace.path, ".env"))

    const made = await service.commit(workspace.path, { repositoryPath, sessionId, message: "chore: drop the env file", expectedHead: head })

    expect(made.changedFiles).toEqual([".env"])
    await expect(git(workspace.path, "show", `${made.commit}:.env`)).rejects.toThrow()
  })

  it("refuses when there is nothing to commit", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-empty-")
    await writeFile(join(workspace.path, "ignored.log"), "ignored\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit }))

    expect(error.reason).toBe("nothing-to-commit")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it("never runs a hook the worktree or the repository sets", async () => {
    const { scratch, repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-hooks-")
    await git(repositoryPath, "config", "core.hooksPath", ".githooks")
    const markerPath = join(scratch, "hook-ran").replaceAll("\\", "/")
    const hooks = join(workspace.path, ".githooks")
    await mkdir(hooks)
    await writeFile(join(hooks, "pre-commit"), `#!/bin/sh\necho "$(basename "$0")" >> "${markerPath}"\n`, { mode: 0o755 })
    for (const hook of ["prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction", "pre-push"]) {
      await link(join(hooks, "pre-commit"), join(hooks, hook))
    }
    // The control: Git itself runs them in this worktree.
    await git(workspace.path, "commit", "--allow-empty", "-q", "-m", "control")
    await expect(readFile(markerPath, "utf8")).resolves.toContain("pre-commit")
    await rm(markerPath)
    const head = await git(workspace.path, "rev-parse", "HEAD")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: head })

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })
})
