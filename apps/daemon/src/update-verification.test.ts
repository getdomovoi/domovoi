import { generateKeyPairSync, sign } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  canonicalUpdateJson,
  selectUpdateTarget,
  verifyUpdateMetadata,
  verifyUpdateRoot,
} from "./update-verification.js"

function keyMaterial() {
  const pair = generateKeyPairSync("ed25519")
  const der = pair.publicKey.export({ format: "der", type: "spki" })
  return { pair, public: der.subarray(-32).toString("base64") }
}

function makeFixture() {
  const key = keyMaterial()
  const keyid = "a".repeat(64)
  const signed = {
    _type: "root" as const,
    spec_version: "1.0.31",
    consistent_snapshot: true,
    version: 1,
    expires: "2027-01-01T00:00:00.000Z",
    keys: { [keyid]: { keytype: "ed25519" as const, scheme: "ed25519" as const, keyval: { public: key.public } } },
    roles: {
      root: { keyids: [keyid], threshold: 1 },
      targets: { keyids: [keyid], threshold: 1 },
      snapshot: { keyids: [keyid], threshold: 1 },
      timestamp: { keyids: [keyid], threshold: 1 },
    },
  }
  const sig = sign(null, Buffer.from(canonicalUpdateJson(signed)), key.pair.privateKey).toString("base64")
  return { root: { signed, signatures: [{ keyid, sig }] }, keyid, key }
}

describe("daemon update verification", () => {
  it("verifies a root signature over canonical signed bytes", () => {
    const fixture = makeFixture()
    expect(verifyUpdateRoot(fixture.root, fixture.root).signed.version).toBe(1)
    const altered = { ...fixture.root, signed: { ...fixture.root.signed, version: 2 } }
    expect(() => verifyUpdateRoot(altered, fixture.root)).toThrow(/threshold/)
    const sameVersionSigned = { ...fixture.root.signed, expires: "2028-01-01T00:00:00.000Z" }
    const sameVersion = { signed: sameVersionSigned, signatures: [{ keyid: fixture.keyid, sig: sign(null, Buffer.from(canonicalUpdateJson(sameVersionSigned)), fixture.key.pair.privateKey).toString("base64") }] }
    expect(() => verifyUpdateRoot(sameVersion, fixture.root)).toThrow(/existing version/)
  })

  it("requires the delegated threshold for targets", () => {
    const fixture = makeFixture()
    const signed = { _type: "targets" as const, spec_version: "1.0.31", version: 1, expires: "2027-01-01T00:00:00.000Z", targets: {} }
    const envelope = { signed, signatures: [{ keyid: fixture.keyid, sig: sign(null, Buffer.from(canonicalUpdateJson(signed)), fixture.key.pair.privateKey).toString("base64") }] }
    expect(verifyUpdateMetadata("targets", envelope, fixture.root)).toMatchObject({ signed: { _type: "targets" } })
    const expiredSigned = { ...signed, expires: "2020-01-01T00:00:00.000Z" }
    const expiredEnvelope = { signed: expiredSigned, signatures: [{ keyid: fixture.keyid, sig: sign(null, Buffer.from(canonicalUpdateJson(expiredSigned)), fixture.key.pair.privateKey).toString("base64") }] }
    expect(() => verifyUpdateMetadata("targets", expiredEnvelope, fixture.root)).toThrow(/expired/)
  })

  it("selects the highest channel target and rejects malformed names", () => {
    const targets = {
      signed: {
        _type: "targets" as const,
        spec_version: "1.0.31",
        version: 1,
        expires: "2027-01-01T00:00:00.000Z",
        targets: {
          "getdomovoi-daemon-1.2.0.tgz": { length: 10, hashes: { sha256: "a".repeat(64) }, custom: { schemaVersion: 1 as const, version: "1.2.0", channel: "stable" as const, sourceCommit: "a".repeat(40), runtimeLockDigest: `sha256:${"b".repeat(64)}` } },
          "wrong-name": { length: 10, hashes: { sha256: "a".repeat(64) }, custom: { schemaVersion: 1 as const, version: "9.0.0", channel: "stable" as const, sourceCommit: "a".repeat(40), runtimeLockDigest: `sha256:${"b".repeat(64)}` } },
        },
      },
      signatures: [{ keyid: "a".repeat(64), sig: "sig" }],
    }
    expect(() => selectUpdateTarget(targets, "stable", "1.0.0")).toThrow()
    const valid = { ...targets, signed: { ...targets.signed, targets: { "getdomovoi-daemon-1.2.0.tgz": targets.signed.targets["getdomovoi-daemon-1.2.0.tgz"] } } }
    expect(selectUpdateTarget(valid, "stable", "1.0.0")).toEqual({ name: "getdomovoi-daemon-1.2.0.tgz", version: "1.2.0", sourceCommit: "a".repeat(40) })
    expect(selectUpdateTarget(valid, "stable", "2.0.0")).toBeUndefined()
  })
})
