import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { claimProfile } from "./profile-lease.js"
import { bootstrapInstall, persistTrustedUpdateMetadata, readTrustedUpdateMetadata, stageVerifiedUpdate,
  readActivationRuntime, readActivationJournal, persistActivationJournal, type ActivationJournal } from "./update-state.js"

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
  async function activationFixture() {
    const home = await mkdtemp(join(tmpdir(), "domovoi-activation-receipt-"))
    const lease = claimProfile(home)
    const root = join(home, "runtimes")
    const release = join(root, "v1.2.3")
    const runtime = join(release, ".runtime-fixture", "package")
    await mkdir(join(runtime, "runtime"), { recursive: true, mode: 0o700 })
    const lock = Buffer.from('{"lockfileVersion":3}\n')
    const lockSha256 = sha256(lock)
    const target = {
      name: "getdomovoi-daemon-1.2.3.tgz", version: "1.2.3", channel: "stable" as const,
      sha256: "a".repeat(64), sourceCommit: "b".repeat(40), runtimeLockDigest: `sha256:${lockSha256}`,
    }
    const receipt = { format: 1, version: target.version, sha256: target.sha256, lockSha256, directory: ".runtime-fixture/package" }
    const receiptPath = join(release, "runtime.json")
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
    // Real bootstrap archives retain ordinary read modes inside the private tree.
    const lockPath = join(runtime, "runtime", "lock.json")
    await writeFile(lockPath, lock, { mode: 0o644 })
    await chmod(lockPath, 0o644)
    return { home, lease, root, release, runtime, receipt, receiptPath, lockPath, target,
      cleanup: async () => { lease.release(); await rm(home, { recursive: true, force: true }) } }
  }

  it("binds the signed target to the private receipt and a normal 0644 runtime lock", async () => {
    const f = await activationFixture()
    try {
      const runtime = readActivationRuntime(f.root, f.target)
      expect(runtime).toMatchObject({ version: f.target.version, sha256: f.target.sha256,
        sourceCommit: f.target.sourceCommit, runtimeLockDigest: f.target.runtimeLockDigest })
      expect(runtime.path).toMatch(/\.runtime-fixture[/\\]package$/)
      expect(runtime.receiptDigest).toBe(sha256(await readFile(f.receiptPath)))
      expect(f.receipt).not.toHaveProperty("sourceCommit")
    } finally { await f.cleanup() }
  })

  it.each(["version", "sha256", "lockSha256", "directory"] as const)("rejects a mismatched receipt %s without authorizing activation", async (field) => {
    const f = await activationFixture()
    try {
      await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, [field]: field === "version" ? "1.2.4" : field === "directory" ? "../../foreign" : "c".repeat(64) }))
      expect(() => readActivationRuntime(f.root, f.target)).toThrow()
    } finally { await f.cleanup() }
  })

  it("rejects changed lock bytes and a runtime directory link", async () => {
    const f = await activationFixture()
    try {
      await writeFile(f.lockPath, "changed")
      expect(() => readActivationRuntime(f.root, f.target)).toThrow(/signed target/)
      const linked = join(f.release, ".runtime-linked")
      await symlink(join(f.release, ".runtime-fixture"), linked, "junction")
      await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, directory: ".runtime-linked/package" }))
      expect(() => readActivationRuntime(f.root, f.target)).toThrow(/links/)
    } finally { await f.cleanup() }
  })

  it("persists a strict bounded crash journal under the profile lease and preserves trust", async () => {
    const f = await activationFixture()
    try {
      const target = readActivationRuntime(f.root, f.target)
      const journal: ActivationJournal = { format: 1, id: "12345678-1234-4234-8234-123456789abc", generation: "generation-1",
        previousRevision: "12345678-1234-4234-8234-123456789abd", rollbackRevision: "12345678-1234-4234-8234-123456789abe",
        phase: "prepared", previous: { ...target, version: "1.2.2" }, target }
      expect(readActivationJournal(f.home)).toBeUndefined()
      await persistTrustedUpdateMetadata(f.home, f.lease, metadata)
      await persistActivationJournal(f.home, f.lease, journal)
      expect(readActivationJournal(f.home)).toEqual(journal)
      await expect(persistActivationJournal(f.home, f.lease, { ...journal, generation: "x".repeat(129) })).rejects.toThrow()
      expect(readActivationJournal(f.home)).toEqual(journal)
      expect(await readTrustedUpdateMetadata(f.home)).toEqual(metadata)
      f.lease.release()
      await expect(persistActivationJournal(f.home, f.lease, { ...journal, phase: "starting" })).rejects.toThrow(/lease/)
      expect(readActivationJournal(f.home)).toEqual(journal)
      await writeFile(join(f.home, ".domovoi", "update-activation.json"), "x".repeat(16 * 1024 + 1))
      expect(() => readActivationJournal(f.home)).toThrow(/invalid or inaccessible/)
    } finally { await f.cleanup() }
  })

  it("refuses stored documents whose bytes do not match their trust record", async () => {
    const home = await mkdtemp(join(tmpdir(), "domovoi-update-document-test-"))
    const lease = claimProfile(home)
    try {
      await writeFile(join(home, ".domovoi", "update-metadata.json"), JSON.stringify({
        ...metadata, documents: { root: JSON.stringify({ signed: { version: 1 } }) },
      }))
      await expect(readTrustedUpdateMetadata(home)).rejects.toThrow(/does not match/)
    } finally {
      lease.release()
      await rm(home, { recursive: true, force: true })
    }
  })

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
