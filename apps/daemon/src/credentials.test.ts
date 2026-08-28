import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadOrCreateDaemonToken } from "./credentials.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("loadOrCreateDaemonToken", () => {
  it("creates and reuses a high-entropy private credential", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-credential-"))
    scratchDirectories.push(scratch)
    const tokenPath = join(scratch, "state", "daemon.token")

    const created = await loadOrCreateDaemonToken(tokenPath)
    const reused = await loadOrCreateDaemonToken(tokenPath)

    expect(created).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(reused).toBe(created)
    await expect(readFile(tokenPath, "utf8")).resolves.toBe(`${created}\n`)
    if (process.platform !== "win32") {
      expect((await stat(join(scratch, "state"))).mode & 0o777).toBe(0o700)
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    }
  })

  it("rejects a malformed stored credential", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-credential-"))
    scratchDirectories.push(scratch)
    const tokenPath = join(scratch, "daemon.token")
    await writeFile(tokenPath, "too-short\n")

    await expect(loadOrCreateDaemonToken(tokenPath)).rejects.toThrow(
      "Daemon credential is malformed",
    )
  })

  it("returns one credential to concurrent daemon starts", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-credential-"))
    scratchDirectories.push(scratch)
    const tokenPath = join(scratch, "daemon.token")

    const credentials = await Promise.all([
      loadOrCreateDaemonToken(tokenPath),
      loadOrCreateDaemonToken(tokenPath),
    ])

    expect(new Set(credentials)).toHaveLength(1)
    expect(credentials[0]).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("waits for a concurrently created credential to finish writing", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-credential-"))
    scratchDirectories.push(scratch)
    const tokenPath = join(scratch, "daemon.token")
    const token = "a".repeat(43)
    await writeFile(tokenPath, "")

    const writer = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(tokenPath, `${token}\n`).then(resolve, reject)
      }, 5)
    })

    await expect(loadOrCreateDaemonToken(tokenPath)).resolves.toBe(token)
    await writer
  })
})
