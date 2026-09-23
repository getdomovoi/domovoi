import { execFile } from "node:child_process"
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { codexHistoryScanLimits, committedCodexSecretPaths, gitSupportsNoLazyFetch, historyScanGit } from "./codex-git-secrets.js"
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

  it("does not scan a repository whose Git settings could run a program, and reports that it could not finish", async () => {
    const { root, run } = await repository()
    await writeFile(join(root, ".env"), "x\n")
    await run("add", ".")
    await run("commit", "-qm", "x")
    await expect(committedCodexSecretPaths(root)).resolves.toEqual([".env"])
    await run("config", "core.fsmonitor", join(root, "helper"))

    await expect(committedCodexSecretPaths(root)).resolves.toBeUndefined()
  })

  it("does not scan a partial clone, where git log could fetch through the remote's programs", async () => {
    const server = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-secrets-server-")))
    const parent = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-secrets-partial-")))
    scratchDirectories.push(server, parent)
    const g = (cwd: string, ...args: string[]) => git("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args])
    await g(server, "init", "-q")
    await g(server, "config", "uploadpack.allowFilter", "true")
    await mkdir(join(server, "d"))
    await writeFile(join(server, "d", ".env"), "x\n")
    await g(server, "add", "d/.env")
    await g(server, "commit", "-qm", "x")
    await g(parent, "clone", "-q", "--no-checkout", "--filter=tree:0", `file://${server}`, "clone")
    const marker = join(parent, "uploadpack-ran")
    await writeFile(join(parent, "up"), `#!/bin/sh\necho ran >> "${marker}"\nexec git-upload-pack "$@"\n`)
    await chmod(join(parent, "up"), 0o755)
    await g(join(parent, "clone"), "config", "remote.origin.uploadpack", join(parent, "up"))

    await expect(committedCodexSecretPaths(join(parent, "clone"))).resolves.toBeUndefined()
    await expect(access(marker)).rejects.toThrow()
  })

  it("cannot fetch during the scan even if the repository enables a transport after the gate ran", async () => {
    const server = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-secrets-race-server-")))
    const parent = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-secrets-race-")))
    scratchDirectories.push(server, parent)
    const g = (cwd: string, ...args: string[]) => git("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args])
    await g(server, "init", "-q")
    await g(server, "config", "uploadpack.allowFilter", "true")
    await mkdir(join(server, "d"))
    await writeFile(join(server, "d", ".env"), "x\n")
    await g(server, "add", "d/.env")
    await g(server, "commit", "-qm", "x")
    await g(parent, "clone", "-q", "--no-checkout", "--filter=tree:0", `file://${server}`, "clone")
    const clone = join(parent, "clone")
    const marker = join(parent, "uploadpack-ran")
    await writeFile(join(parent, "up"), `#!/bin/sh\necho ran >> "${marker}"\nexec git-upload-pack "$@"\n`)
    await chmod(join(parent, "up"), 0o755)
    await g(clone, "config", "remote.origin.uploadpack", join(parent, "up"))
    await g(clone, "config", "protocol.file.allow", "always")
    const env = { ...process.env }
    delete env.GIT_NO_LAZY_FETCH

    const scan = git("git", ["-C", clone, ...historyScanGit, "log", "--all", "--name-only", "--format=%x01", "--", ":(glob)**/.env"], { env })
    await expect(scan).rejects.toThrow()
    await expect(access(marker)).rejects.toThrow()
  })

  it.each([
    ["git version 2.43.0", false],
    ["git version 2.44.1", false],
    ["git version 2.45.0", true],
    ["git version 2.45.0.windows.1", true],
    ["git version 2.54.0 (Apple Git-157)", true],
    ["git version 3.0.0", true],
    [undefined, false],
  ])("knows whether %s can refuse lazy fetches", (version, supported) => {
    expect(gitSupportsNoLazyFetch(version)).toBe(supported)
  })

  it("does not scan with a Git that cannot refuse lazy fetches, and reports that it could not finish", async () => {
    const { root, run } = await repository()
    await writeFile(join(root, ".env"), "x\n")
    await run("add", ".")
    await run("commit", "-qm", "x")

    await expect(committedCodexSecretPaths(root, codexHistoryScanLimits, { gitVersion: async () => "git version 2.43.0" })).resolves.toBeUndefined()
    await expect(committedCodexSecretPaths(root, codexHistoryScanLimits, { gitVersion: async () => "git version 2.45.0" })).resolves.toEqual([".env"])
  })

  it("bounds the scan", () => {
    expect(codexHistoryScanLimits).toEqual({ commits: 1_000, timeoutMs: 3_000, outputBytes: 256 * 1_024 })
  })
})
