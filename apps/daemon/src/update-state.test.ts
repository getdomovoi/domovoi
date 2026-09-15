import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { claimProfile } from "./profile-lease.js"
import { persistTrustedUpdateMetadata, readTrustedUpdateMetadata, stageVerifiedUpdate } from "./update-state.js"

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
        version: "1.2.3",
        baseUrl: "https://updates.example.test/",
        expectedSha256: "a".repeat(64),
        install: async (options) => {
          calls.push(options)
          return { version: options.version, path: join(options.destination, "v1.2.3"), sha256: options.expectedSha256 }
        },
      })
      expect(result.version).toBe("1.2.3")
      expect(calls).toEqual([expect.objectContaining({ destination: join(home, ".domovoi", "runtimes") })])
    } finally {
      lease.release()
    }
  })
})
