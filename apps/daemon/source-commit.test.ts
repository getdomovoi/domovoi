import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { readSourceCommit } from "./source-commit.js"
import { removeScratchDirectories } from "./src/test-scratch.js"

const directories: string[] = []
afterEach(() => removeScratchDirectories(directories))

function scratchDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-source-commit-"))
  directories.push(directory)
  return directory
}

function repository() {
  const directory = scratchDirectory()
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: directory, stdio: ["ignore", "pipe", "ignore"],
  }).toString().trim()
  git("init")
  git("config", "user.name", "Source Commit Test")
  git("config", "user.email", "source-commit@example.test")
  git("config", "commit.gpgsign", "false")
  writeFileSync(join(directory, "tracked.txt"), "committed\n")
  git("add", "tracked.txt")
  git("commit", "-m", "test: create source fixture")
  return { directory, head: git("rev-parse", "HEAD") }
}

describe("readSourceCommit", () => {
  it("omits the commit outside a Git repository", () => {
    expect(readSourceCommit(scratchDirectory())).toBeUndefined()
  })

  it("returns HEAD for a clean repository", () => {
    const { directory, head } = repository()
    expect(readSourceCommit(directory)).toBe(head)
  })

  it("omits a containing repository's commit for a nested directory", () => {
    const { directory } = repository()
    const nested = join(directory, "unpacked-source")
    mkdirSync(nested)
    expect(readSourceCommit(nested)).toBeUndefined()
  })

  it("omits the commit when a tracked file is modified", () => {
    const { directory } = repository()
    writeFileSync(join(directory, "tracked.txt"), "modified\n")
    expect(readSourceCommit(directory)).toBeUndefined()
  })

  it("ignores untracked files", () => {
    const { directory, head } = repository()
    writeFileSync(join(directory, "untracked.txt"), "untracked\n")
    expect(readSourceCommit(directory)).toBe(head)
  })
})
