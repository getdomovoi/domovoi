import { describe, expect, it } from "vitest"

import {
  updateActivateParamsSchema,
  updateRootMetadataSchema,
  updateStatusSchema,
  updateTargetCustomSchema,
  updateTargetsMetadataSchema,
} from "./update.js"

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
