import { generateKeyPairSync, sign } from "node:crypto"
import { createHash } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  canonicalUpdateJson,
  fetchUpdateMetadata,
  selectUpdateTarget,
  updateFetchTimeoutMs,
  updateInactivityTimeoutMs,
  maximumUpdateMetadataBytes,
  verifyUpdateChain,
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
  afterEach(() => vi.useRealTimers())

  function signedEnvelope(signed: Record<string, unknown>, fixture: ReturnType<typeof makeFixture>) {
    return {
      signed,
      signatures: [{ keyid: fixture.keyid, sig: sign(null, Buffer.from(canonicalUpdateJson(signed)), fixture.key.pair.privateKey).toString("base64") }],
    }
  }

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
    const baseTarget = valid.signed.targets["getdomovoi-daemon-1.2.0.tgz"]!
    const buildTarget = { ...baseTarget, custom: { ...baseTarget.custom, version: "1.2.0+build" } }
    const buildMetadata = { ...valid, signed: { ...valid.signed, targets: { "getdomovoi-daemon-1.2.0+build.tgz": buildTarget } } }
    expect(selectUpdateTarget(buildMetadata, "stable", "1.2.0")).toBeUndefined()
  })

  it("verifies the complete chain against the exact served JSON bytes", () => {
    const fixture = makeFixture()
    const target = { length: 10, hashes: { sha256: "a".repeat(64) }, custom: { schemaVersion: 1 as const, version: "1.2.0", channel: "stable" as const, sourceCommit: "a".repeat(40), runtimeLockDigest: `sha256:${"b".repeat(64)}` } }
    const targets = signedEnvelope({ _type: "targets", spec_version: "1.0.31", version: 3, expires: "2027-01-01T00:00:00.000Z", targets: { "getdomovoi-daemon-1.2.0.tgz": target } }, fixture)
    const targetsBytes = Buffer.from(JSON.stringify(targets))
    const snapshot = signedEnvelope({ _type: "snapshot", spec_version: "1.0.31", version: 2, expires: "2027-01-01T00:00:00.000Z", meta: { "targets.json": { version: 3, length: targetsBytes.length, hashes: { sha256: Buffer.from(awaitableDigest(targetsBytes), "hex").toString("hex") } } } }, fixture)
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot))
    const timestamp = signedEnvelope({ _type: "timestamp", spec_version: "1.0.31", version: 4, expires: "2027-01-01T00:00:00.000Z", meta: { "snapshot.json": { version: 2, length: snapshotBytes.length, hashes: { sha256: awaitableDigest(snapshotBytes) } } } }, fixture)
    const values = { root: fixture.root, timestamp, snapshot, targets, raw: { "snapshot.json": snapshotBytes, "targets.json": targetsBytes } }
    expect(verifyUpdateChain(values, fixture.root, Date.parse("2026-09-15T00:00:00.000Z")).signed.version).toBe(1)
    const changed = Uint8Array.from(snapshotBytes); changed[0] = changed[0] === 123 ? 124 : 123
    expect(() => verifyUpdateChain({ ...values, raw: { ...values.raw, "snapshot.json": changed } }, fixture.root, Date.parse("2026-09-15T00:00:00.000Z"))).toThrow("does not bind the snapshot bytes")
  })

  it("refuses oversized and stalled metadata streams", async () => {
    const oversizedFetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(maximumUpdateMetadataBytes + 1)); controller.close() } }), { status: 200 }))
    await expect(fetchUpdateMetadata("https://updates.example.test/", oversizedFetcher)).rejects.toThrow("byte limit")

    vi.useFakeTimers()
    const stalledFetcher = vi.fn(async () => new Response(new ReadableStream(), { status: 200 }))
    const pending = expect(fetchUpdateMetadata("https://updates.example.test/", stalledFetcher)).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(updateInactivityTimeoutMs + 1)
    await pending
    expect(updateFetchTimeoutMs).toBeGreaterThan(updateInactivityTimeoutMs)
  })
})

function awaitableDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
