import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { claudeReadOutsideWorktree, claudeShellReadIsListed } from "./claude-read-scope.js"
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

  it.each([
    "echo L2V0Yy9wYXNzd2Q= | base64 -d | xargs cat",
    "printf '\\057etc\\057passwd' | xargs cat",
    "find src -type l -exec cat {} +",
    "grep -R secret src",
    "ls -R src",
    "ls -laR src",
    "git log -p",
    "git show HEAD",
    "cat src/*.ts",
    "cd src && cat index.ts",
    "rg secret",
  ])("does not let a read Domovoi cannot resolve at parse time skip the card: %s", (command) => {
    expect(claudeShellReadIsListed(command)).toBe(false)
  })

  it.each([
    "cat src/index.ts",
    "head -n 5 src/index.ts | wc -l",
    "tail -20 README.md",
    "ls -la src 2>/dev/null",
    "ls",
    "git status --short",
    "git log --oneline -n 5",
    "git diff --stat",
  ])("lets a short-list read whose arguments are all paths skip the card: %s", (command) => {
    expect(claudeShellReadIsListed(command)).toBe(true)
  })

  it("judges a glob by the directory it starts from", async () => {
    const { root, scratch } = await worktree()

    await expect(claudeReadOutsideWorktree("Glob", { pattern: "src/**/*.ts" }, root)).resolves.toBeUndefined()
    await expect(claudeReadOutsideWorktree("Glob", { pattern: `${scratch}/*` }, root)).resolves.toBe(`${scratch}/*`)
  })
})
