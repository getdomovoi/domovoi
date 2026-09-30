import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { readRepositoryGitFilters } from "./repository-git-filters.js"
import { removeScratchDirectories } from "./test-scratch.js"

const execute = promisify(execFile)
const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories)
})

async function repository() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-filters-")))
  scratchDirectories.push(scratch)
  const root = join(scratch, "project")
  const git = (...args: string[]) => execute("git", ["-C", root, ...args])
  await execute("git", ["init", "--initial-branch=main", root])
  await writeFile(join(root, "a.txt"), "a\n")
  await git("add", ".")
  await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "initial")
  return { scratch, root, git }
}

describe("readRepositoryGitFilters", () => {
  it("lists a filter the repository's own config sets, by scope, driver, operation and file", async () => {
    const { root, git } = await repository()
    await git("config", "filter.sops.smudge", "sops --decrypt /dev/stdin")
    await git("config", "filter.sops.required", "true")

    expect(await readRepositoryGitFilters(root)).toEqual([{
      scope: "local",
      key: "filter.sops.smudge",
      driver: "sops",
      operation: "smudge",
      value: "sops --decrypt /dev/stdin",
      origin: join(root, ".git", "config"),
    }])
  })

  it("lists nothing for a repository that sets no filter, or a folder outside any repository", async () => {
    const { scratch, root } = await repository()
    expect(await readRepositoryGitFilters(root)).toEqual([])
    const outside = join(scratch, "outside")
    await mkdir(outside)
    expect(await readRepositoryGitFilters(outside)).toEqual([])
  })

  it("names the included file a filter comes from", async () => {
    const { scratch, root, git } = await repository()
    const included = join(scratch, "project.gitconfig")
    await writeFile(included, "[filter \"crypt\"]\n\tclean = git-crypt clean\n")
    await git("config", "include.path", included)

    expect(await readRepositoryGitFilters(root)).toEqual([expect.objectContaining({
      scope: "local", driver: "crypt", operation: "clean", origin: included,
    })])
  })

  it("reads a worktree's own config, which a new worktree copies from the one it was added from", async () => {
    const { scratch, root, git } = await repository()
    await git("config", "extensions.worktreeConfig", "true")
    await git("config", "--worktree", "filter.crypt.smudge", "git-crypt smudge")
    const linked = join(scratch, "linked")
    await git("worktree", "add", "--no-checkout", "-b", "linked", linked, "HEAD")

    expect(await readRepositoryGitFilters(root)).toEqual([expect.objectContaining({ scope: "worktree", driver: "crypt" })])
    expect(await readRepositoryGitFilters(linked)).toEqual([expect.objectContaining({
      scope: "worktree", driver: "crypt", operation: "smudge", value: "git-crypt smudge",
    })])
  })

  it("reads a filter a conditional include adds only on a session branch, as the session worktree sees it", async () => {
    const { scratch, root, git } = await repository()
    const included = join(scratch, "session.gitconfig")
    await writeFile(included, "[filter \"probe\"]\n\tsmudge = cat\n")
    await git("config", "includeIf.onbranch:domovoi/**.path", included)
    const session = join(scratch, "session")
    await git("worktree", "add", "--no-checkout", "-b", "domovoi/session-1", session, "HEAD")

    expect(await readRepositoryGitFilters(root)).toEqual([])
    expect(await readRepositoryGitFilters(session)).toEqual([expect.objectContaining({ scope: "local", driver: "probe", origin: included })])
  })

  // Ruling Q207 A: the lines `git lfs install --local` writes run the person's
  // own git-lfs, as a global install does.
  it("leaves out the exact lines git lfs install writes, and lists any other lfs line", async () => {
    const { root, git } = await repository()
    await git("config", "filter.lfs.clean", "git-lfs clean -- %f")
    await git("config", "filter.lfs.smudge", "git-lfs smudge -- %f")
    await git("config", "filter.lfs.process", "git-lfs filter-process")
    await git("config", "filter.lfs.required", "true")
    expect(await readRepositoryGitFilters(root)).toEqual([])

    await git("config", "filter.LFS.clean", "git-lfs clean -- %f")
    await git("config", "filter.lfs.smudge", "sh ./payload.sh")
    // A subsection is case-sensitive: [filter "LFS"] is another driver.
    expect((await readRepositoryGitFilters(root)).map(({ key, value }) => [key, value]).sort()).toEqual([
      ["filter.LFS.clean", "git-lfs clean -- %f"],
      ["filter.lfs.smudge", "sh ./payload.sh"],
    ])
  })

  // Only "not a Git repository" means there is no config to read; any other
  // failure is reported with a reason code, never read as no filters.
  it("fails with a reason when Git cannot read the config, and reads a folder that is no repository as none", async () => {
    const { scratch, root, git } = await repository()
    const many = Array.from({ length: 40_000 }, (_, index) => `[filter "f${index}"]\n\tsmudge = cat\n`).join("")
    await writeFile(join(scratch, "many.gitconfig"), many)
    await git("config", "include.path", join(scratch, "many.gitconfig"))
    await expect(readRepositoryGitFilters(root)).rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", reason: "too-large" })

    await writeFile(join(root, ".git", "config"), "[filter \"broken\"\n\tsmudge = cat\n")
    await expect(readRepositoryGitFilters(root)).rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", reason: "git-failed" })

    const linked = join(scratch, "linked")
    await mkdir(linked)
    await writeFile(join(linked, ".git"), "gitdir: ./missing\n")
    expect(await readRepositoryGitFilters(linked)).toEqual([])
  })

  it("leaves out a line with no command, which runs nothing", async () => {
    const { root, git } = await repository()
    await git("config", "filter.off.clean", "")
    expect(await readRepositoryGitFilters(root)).toEqual([])
  })
})
