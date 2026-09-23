import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { claudeReadOutsideWorktree } from "./claude-read-scope.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

async function worktree() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "domovoi-read-scope-")))
  scratchDirectories.push(scratch)
  const root = join(scratch, "worktree")
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(scratch, "secret"), "secret\n")
  return { root, scratch }
}

describe("claudeReadOutsideWorktree", () => {
  it.runIf(process.platform !== "win32")("follows a link inside the worktree to where it points", async () => {
    const { root, scratch } = await worktree()
    await symlink(join(scratch, "secret"), join(root, "innocent.txt"))

    await expect(claudeReadOutsideWorktree("Bash", { command: "cat innocent.txt" }, root)).resolves.toBe("innocent.txt")
    await expect(claudeReadOutsideWorktree("Read", { file_path: join(root, "innocent.txt") }, root))
      .resolves.toBe(join(root, "innocent.txt"))
  })

  it("reads a path glued to a flag", async () => {
    const { root } = await worktree()

    await expect(claudeReadOutsideWorktree("Bash", { command: "grep -f/etc/hosts src" }, root)).resolves.toBe("/etc/hosts")
    await expect(claudeReadOutsideWorktree("Bash", { command: "grep --file=../secret src" }, root)).resolves.toBe("../secret")
  })

  it("treats a shell that already left the worktree as outside for every command", async () => {
    const { root, scratch } = await worktree()

    await expect(claudeReadOutsideWorktree("Bash", { command: "ls" }, root, scratch)).resolves.toBe(scratch)
    await expect(claudeReadOutsideWorktree("Bash", { command: "ls" }, root, join(root, "src"))).resolves.toBeUndefined()
  })

  it("judges a glob by the directory it starts from", async () => {
    const { root, scratch } = await worktree()

    await expect(claudeReadOutsideWorktree("Glob", { pattern: "src/**/*.ts" }, root)).resolves.toBeUndefined()
    await expect(claudeReadOutsideWorktree("Glob", { pattern: `${scratch}/*` }, root)).resolves.toBe(`${scratch}/*`)
  })
})
