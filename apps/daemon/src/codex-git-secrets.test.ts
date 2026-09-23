import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { codexHistoryScanLimits, committedCodexSecretPaths } from "./codex-git-secrets.js"
import { removeScratchDirectories } from "./test-scratch.js"

const git = promisify(execFile)
const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-secrets-")))
  scratchDirectories.push(root)
  const run = (...args: string[]) => git("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args])
  await run("init", "-q")
  return { root, run }
}

describe("committedCodexSecretPaths", () => {
  it("lists every file in the repository history that the Codex sandbox denies, deleted ones included", async () => {
    const { root, run } = await repository()
    await mkdir(join(root, "certs"), { recursive: true })
    await writeFile(join(root, ".env"), "TOKEN=1\n")
    await writeFile(join(root, "app.ts"), "export {}\n")
    await run("add", ".")
    await run("commit", "-qm", "one")
    await rm(join(root, ".env"))
    await writeFile(join(root, "certs", "dev.pem"), "pem\n")
    await writeFile(join(root, ".env.example"), "TOKEN=\n")
    await run("add", "-A")
    await run("commit", "-qm", "two")

    await expect(committedCodexSecretPaths(root)).resolves.toEqual([".env", ".env.example", "certs/dev.pem"])
  })

  it("lists nothing for a history without denied files", async () => {
    const { root, run } = await repository()
    await writeFile(join(root, "app.ts"), "export {}\n")
    await run("add", ".")
    await run("commit", "-qm", "one")

    await expect(committedCodexSecretPaths(root)).resolves.toEqual([])
  })

  it("reports that it could not tell when the directory is not a repository", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-secrets-none-")))
    scratchDirectories.push(root)

    await expect(committedCodexSecretPaths(root)).resolves.toBeUndefined()
  })

  it("reports that it could not finish when the history reaches the commit bound", async () => {
    const { root, run } = await repository()
    for (const name of [".env", ".env.local", "server.pem"]) {
      await writeFile(join(root, name), "x\n")
      await run("add", ".")
      await run("commit", "-qm", name)
    }

    await expect(committedCodexSecretPaths(root, { ...codexHistoryScanLimits, commits: 3 })).resolves.toBeUndefined()
    await expect(committedCodexSecretPaths(root, { ...codexHistoryScanLimits, commits: 4 })).resolves.toEqual([".env", ".env.local", "server.pem"])
  })

  it("bounds the scan", () => {
    expect(codexHistoryScanLimits).toEqual({ commits: 1_000, timeoutMs: 3_000, outputBytes: 256 * 1_024 })
  })
})
