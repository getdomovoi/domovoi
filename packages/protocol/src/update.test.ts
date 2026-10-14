import { describe, expect, it } from "vitest"

import {
  updateActivateParamsSchema,
  updateRootMetadataSchema,
  updateStatusSchema,
  updateTargetCustomSchema,
  updateTargetsMetadataSchema,
  releaseInventorySchema,
} from "./update.js"

const daemonTarget = { length: 12, hashes: { sha256: "a".repeat(64) }, custom: {
  schemaVersion: 1, version: "1.2.3", channel: "stable", sourceCommit: "b".repeat(40),
  runtimeLockDigest: `sha256:${"c".repeat(64)}`,
} }
const inventoryTarget = { length: 123, hashes: { sha256: "d".repeat(64) }, custom: {
  schemaVersion: 1, kind: "release-inventory", version: "1.2.3", channel: "stable", sourceCommit: "b".repeat(40),
} }
const targets = (entries: Record<string, unknown>) => ({ signed: {
  _type: "targets", spec_version: "1.0.31", version: 1, expires: "2099-01-01T00:00:00Z", targets: entries,
}, signatures: [{ keyid: "a".repeat(64), sig: "a".repeat(128) }] })

function inventory() {
  const version = "1.2.3"
  const files = ["protocol", "credential-store", "daemon", "cli"].flatMap((name) => [
    { kind: "npm", packageName: `@getdomovoi/${name}`, name: `getdomovoi-${name}-${version}.tgz`, length: 10, sha256: "a".repeat(64) },
    { kind: "sbom", packageName: `@getdomovoi/${name}`, name: `getdomovoi-${name}-${version}.sbom.json`, length: 10, sha256: "a".repeat(64) },
  ])
  return { schemaVersion: 2, version, channel: "stable", commit: "b".repeat(40), gitTag: `v${version}`, files: [
    ...files,
    ...[["web", `domovoi-web-${version}.tar.gz`], ["checksums", "SHA256SUMS"], ["reproducibility", "reproducibility.json"]].map(([kind, name]) => ({ kind, name, length: 10, sha256: "a".repeat(64) })),
  ] }
}
const desktop = (arch: "arm64" | "x64") => ({ kind: "desktop", packageName: "@getdomovoi/desktop",
  platform: "darwin", arch, format: "dmg", bundleId: "sh.domovoi.desktop", app: "Domovoi.app",
  name: `domovoi-desktop-1.2.3-${arch}.dmg`, length: 123, sha256: "c".repeat(64),
})

describe("canonical release inventory", () => {
  it("accepts the exact core inventory with optional explicit desktop identities", () => {
    const value = inventory()
    expect(releaseInventorySchema.parse(value)).toEqual(value)
    value.files.push(desktop("arm64"), desktop("x64"))
    expect(releaseInventorySchema.parse(value)).toEqual(value)
  })
  it.each(["core-missing", "duplicate", "duplicate-arch", "wrong-tag", "wrong-version", "unsafe-name", "unknown-field", "wrong-app", "wrong-bundle", "wrong-platform", "wrong-format", "zero-length", "unsafe-length", "bad-hash"])("refuses %s inventory", (kind) => {
    const value = { ...inventory(), files: [...inventory().files, desktop("arm64")] } as Record<string, unknown> & { files: Array<Record<string, unknown>> }
    if (kind === "core-missing") value.files.shift()
    if (kind === "duplicate") value.files.push(value.files[0]!)
    if (kind === "duplicate-arch") value.files.push(desktop("arm64"))
    if (kind === "wrong-tag") value.gitTag = "v9.0.0"
    if (kind === "wrong-version") value.version = "1.2.4"
    if (kind === "unsafe-name") value.files[0]!.name = "../getdomovoi-protocol-1.2.3.tgz"
    if (kind === "unknown-field") value.files[0]!.verified = true
    if (kind === "wrong-app") value.files.at(-1)!.app = "Malicious.app"
    if (kind === "wrong-bundle") value.files.at(-1)!.bundleId = "other.app"
    if (kind === "wrong-platform") value.files.at(-1)!.platform = "win32"
    if (kind === "wrong-format") value.files.at(-1)!.format = "exe"
    if (kind === "zero-length") value.files[0]!.length = 0
    if (kind === "unsafe-length") value.files[0]!.length = Number.MAX_SAFE_INTEGER + 1
    if (kind === "bad-hash") value.files[0]!.sha256 = "A".repeat(64)
    expect(releaseInventorySchema.safeParse(value).success).toBe(false)
  })
})

const root = {
  _type: "root" as const,
  version: 1,
  expires: "2027-01-01T00:00:00.000Z",
  keys: {
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { keytype: "ed25519" as const, scheme: "ed25519" as const, keyval: { public: "pub-a" } },
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: { keytype: "ed25519" as const, scheme: "ed25519" as const, keyval: { public: "pub-b" } },
  },
  roles: {
    root: { keyids: ["a".repeat(64)], threshold: 1 },
    targets: { keyids: ["a".repeat(64)], threshold: 1 },
    snapshot: { keyids: ["b".repeat(64)], threshold: 1 },
    timestamp: { keyids: ["b".repeat(64)], threshold: 1 },
  },
}

describe("auto-update protocol", () => {
  it("preserves old daemon targets byte-for-byte while accepting a distinct release inventory", () => {
    const old = targets({ "getdomovoi-daemon-1.2.3.tgz": daemonTarget })
    expect(updateTargetsMetadataSchema.parse(old)).toEqual(old)
    const mixed = targets({ ...old.signed.targets, "release.json": inventoryTarget })
    expect(updateTargetsMetadataSchema.parse(mixed)).toEqual(mixed)
  })

  it.each([
    { "release.json": daemonTarget },
    { "getdomovoi-daemon-1.2.3.tgz": inventoryTarget },
    { "other-release.json": inventoryTarget },
    { "../release.json": inventoryTarget },
  ])("rejects mismatched inventory name or target kind", (entries) => {
    expect(updateTargetsMetadataSchema.safeParse(targets(entries)).success).toBe(false)
  })

  it("continues requiring the daemon runtime lock in mixed metadata", () => {
    expect(updateTargetsMetadataSchema.safeParse(targets({ "release.json": inventoryTarget,
      "getdomovoi-daemon-1.2.3.tgz": { ...daemonTarget, custom: { ...daemonTarget.custom, runtimeLockDigest: undefined } },
    })).success).toBe(false)
  })
  it("rejects a role threshold that cannot be met", () => {
    const signed = { ...root, spec_version: "1.0.31", consistent_snapshot: true, roles: { ...root.roles, targets: { keyids: ["a".repeat(64)], threshold: 2 } } }
    expect(updateRootMetadataSchema.safeParse({ signed, signatures: [{ keyid: "a".repeat(64), sig: "sig" }] }).success).toBe(false)
  })

  it("requires a signed TUF-shaped root envelope", () => {
    const signed = { ...root, spec_version: "1.0.31", consistent_snapshot: true }
    expect(updateRootMetadataSchema.safeParse(signed).success).toBe(false)
    expect(updateRootMetadataSchema.safeParse({ signed, signatures: [{ keyid: "a".repeat(64), sig: "sig" }] }).success).toBe(true)
  })

  it("rejects a target whose custom identity does not use a canonical source commit", () => {
    expect(updateTargetCustomSchema.safeParse({ schemaVersion: 1, version: "1.2.3", channel: "stable", sourceCommit: "not-a-commit", runtimeLockDigest: `sha256:${"a".repeat(64)}` }).success).toBe(false)
  })

  it("requires pending identity and refusal details to match status", () => {
    expect(updateStatusSchema.safeParse({ channel: "stable", currentVersion: "1.0.0", state: "pending" }).success).toBe(false)
    expect(updateStatusSchema.safeParse({ channel: "stable", currentVersion: "1.0.0", state: "failed" }).success).toBe(false)
    expect(updateStatusSchema.safeParse({ channel: "stable", currentVersion: "1.0.0", state: "deferred" }).success).toBe(false)
  })

  it("keeps activation target optional for the daemon to choose its verified pending target", () => {
    expect(updateActivateParamsSchema.parse({})).toEqual({})
  })

  it("refuses extra metadata fields and oversized signatures", () => {
    const signature = { keyid: "a".repeat(64), sig: "s" }
    const metadata = { signed: { _type: "targets", version: 1, expires: "2027-01-01T00:00:00.000Z", targets: {} }, signatures: [signature], extra: true }
    expect(updateTargetsMetadataSchema.safeParse(metadata).success).toBe(false)
    expect(updateTargetsMetadataSchema.safeParse({ ...metadata, extra: undefined, signatures: [{ ...signature, sig: "x".repeat(4097) }] }).success).toBe(false)
  })
})
