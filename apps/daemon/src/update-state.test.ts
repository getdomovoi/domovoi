import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { claimProfile } from "./profile-lease.js"
import { bootstrapInstall, persistTrustedUpdateMetadata, readTrustedUpdateMetadata, stageVerifiedUpdate } from "./update-state.js"

const execFile = promisify(execFileCallback)
const archiveVersion = "1.2.3"
const sha512 = (value: Buffer) => `sha512-${createHash("sha512").update(value).digest("base64")}`
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex")

const metadata = {
  format: 1 as const,
  rootVersion: 1, rootDigest: "root-a",
  timestampVersion: 2, timestampDigest: "timestamp-a",
  snapshotVersion: 3, snapshotDigest: "snapshot-a",
  targetsVersion: 4, targetsDigest: "targets-a",
}

describe("daemon update state", () => {
  it("persists trusted metadata atomically under a held profile lease", async () => {
    const home = await mkdtemp(join(tmpdir(), "domovoi-update-state-"))
    const lease = claimProfile(home)
    try {
      expect(await readTrustedUpdateMetadata(home)).toMatchObject({ format: 1, rootVersion: 0 })
      await expect(persistTrustedUpdateMetadata(home, lease, metadata)).resolves.toEqual(metadata)
      expect(await readTrustedUpdateMetadata(home)).toEqual(metadata)
      await expect(persistTrustedUpdateMetadata(home, lease, { ...metadata, targetsVersion: 3 })).rejects.toThrow(/cannot roll back/)
      await expect(persistTrustedUpdateMetadata(home, lease, { ...metadata, targetsDigest: "changed" })).rejects.toThrow(/existing version/)
    } finally {
      lease.release()
    }
  })

  it("stages through the injected bootstrap installer with the profile runtime root", async () => {
    const home = await mkdtemp(join(tmpdir(), "domovoi-update-stage-"))
    const lease = claimProfile(home)
    try {
      const calls: unknown[] = []
      const result = await stageVerifiedUpdate({
        homeDirectory: home,
        lease,
        target: {
          name: "getdomovoi-daemon-1.2.3.tgz",
          version: "1.2.3",
          sha256: "a".repeat(64),
          channel: "stable",
          sourceCommit: "b".repeat(40),
          runtimeLockDigest: `sha256:${"c".repeat(64)}`,
        },
        baseUrl: "https://updates.example.test/",
        install: async (options) => {
          calls.push(options)
          return { version: options.version, path: join(options.destination, "v1.2.3"), sha256: options.expectedSha256 }
        },
      })
      expect(result.version).toBe("1.2.3")
      expect(calls).toEqual([expect.objectContaining({ destination: join(home, ".domovoi", "runtimes") })])
      await expect(stageVerifiedUpdate({
        homeDirectory: home,
        lease,
        target: {
          name: "getdomovoi-daemon-1.2.3.tgz", version: "1.2.3", sha256: "a".repeat(64), channel: "stable",
          sourceCommit: "b".repeat(40), runtimeLockDigest: `sha256:${"c".repeat(64)}`,
        },
        baseUrl: "https://updates.example.test/",
        install: async () => ({ version: "1.2.3", path: "wrong", sha256: "d".repeat(64) }),
      })).rejects.toThrow(/did not match/)
    } finally {
      lease.release()
    }
  })

  it("stages a local archive through the real bootstrap installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-update-real-installer-"))
    const source = join(root, "source", "package")
    await mkdir(join(source, "runtime"), { recursive: true })
    await mkdir(join(source, "dist"), { recursive: true })
    const protocol = Buffer.from("protocol fixture")
    const manifest = {
      name: "@getdomovoi/daemon", version: archiveVersion, private: true, type: "module",
      dependencies: { "@getdomovoi/protocol": archiveVersion },
    }
    const lock = {
      name: manifest.name, version: archiveVersion, lockfileVersion: 3, requires: true,
      packages: {
        "": manifest,
        "node_modules/@getdomovoi/protocol": {
          version: archiveVersion, resolved: "file:runtime/protocol.tgz", integrity: sha512(protocol),
        },
      },
    }
    await writeFile(join(source, "runtime/package.json"), JSON.stringify(manifest))
    await writeFile(join(source, "runtime/lock.json"), JSON.stringify(lock))
    await writeFile(join(source, "runtime/protocol.tgz"), protocol)
    await writeFile(join(source, "package.json"), JSON.stringify(manifest))
    await writeFile(join(source, "dist/index.js"), "export const fixture = true\n")
    const archive = join(root, `daemon-${archiveVersion}.tgz`)
    await execFile("tar", ["-czf", archive, "-C", join(root, "source"), "package"])
    const archiveBytes = await readFile(archive)
    const expectedSha256 = sha256(archiveBytes)
    const run = async (command: string, args: string[], options: { cwd?: string, deadline: { signal: AbortSignal, check(): void } }) => {
      options.deadline.check()
      if (args.includes("--version")) return { stdout: "12.0.2\n", stderr: "" }
      if (args.includes("ci")) {
        const cwd = options.cwd!
        await mkdir(join(cwd, "node_modules/@getdomovoi/protocol"), { recursive: true })
        await writeFile(join(cwd, "node_modules/@getdomovoi/protocol/package.json"), JSON.stringify({ name: "@getdomovoi/protocol", version: archiveVersion }))
        await writeFile(join(cwd, "node_modules/.package-lock.json"), JSON.stringify(lock))
        return { stdout: "", stderr: "" }
      }
      return await execFile(command, args, { cwd: options.cwd, signal: options.deadline.signal })
    }
    const lease = claimProfile(root)
    try {
      const target = {
        name: `getdomovoi-daemon-${archiveVersion}.tgz`, version: archiveVersion, sha256: expectedSha256,
        channel: "stable" as const, sourceCommit: "a".repeat(40), runtimeLockDigest: `sha256:${"b".repeat(64)}`,
      }
      const result = await stageVerifiedUpdate({
        homeDirectory: root,
        lease,
        target,
        baseUrl: "https://updates.example.test",
        install: (options) => bootstrapInstall({
          ...options,
          run,
          download: async (url: string) => url.endsWith("SHA256SUMS")
            ? `${expectedSha256}  getdomovoi-daemon-${archiveVersion}.tgz\n`
            : archiveBytes,
        } as Parameters<typeof bootstrapInstall>[0] & Record<string, unknown>),
      })
      expect(result.version).toBe(archiveVersion)
      expect(result.sha256).toBe(expectedSha256)
    } finally {
      lease.release()
    }
  })
})
