import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { updateRootMetadataSchema } from "@getdomovoi/protocol"
import {
  canonicalUpdateJson, fetchUpdateMetadata, selectUpdateTarget,
  maximumUpdateMetadataBytes, updateInactivityTimeoutMs, updateFetchTimeoutMs, maximumUpdateRootRotations,
  type TrustedUpdateDocuments,
} from "./update-verification.js"

function keyMaterial(index: number) {
  const pair = generateKeyPairSync("ed25519")
  return { pair, keyid: index.toString(16).padStart(64, "0"), public: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") }
}
function envelope(signed: Record<string, unknown>, keys: ReturnType<typeof keyMaterial>[]) {
  return { signed, signatures: keys.map(({ keyid, pair }) => ({ keyid, sig: sign(null, Buffer.from(canonicalUpdateJson(signed)), pair.privateKey).toString("hex") })) }
}
function fixture() {
  const offline = [keyMaterial(1), keyMaterial(2), keyMaterial(3)]
  const online = keyMaterial(4)
  const keys = [...offline, online]
  const rootBody = {
    _type: "root", spec_version: "1.0.31", consistent_snapshot: true,
    version: 1, expires: "2099-01-01T00:00:00Z",
    keys: Object.fromEntries(keys.map((key) => [key.keyid, { keytype: "ed25519", scheme: "ed25519", keyval: { public: key.public } }])),
    roles: { root: { keyids: offline.map((key) => key.keyid), threshold: 2 },
      ...Object.fromEntries(["timestamp", "snapshot", "targets"].map((role) => [role, { keyids: [online.keyid], threshold: 1 }])) },
  }
  const makeRoot = (version: number, signers = offline.slice(0, 2)) => envelope({ ...rootBody, version }, signers)
  const root = updateRootMetadataSchema.parse(makeRoot(1))
  const documents: Record<string, unknown> = {}
  const roots: Record<string, unknown> = {}
  const binding = (value: unknown, version: number) => {
    const bytes = Buffer.from(JSON.stringify(value))
    return { version, length: bytes.length, hashes: { sha256: createHash("sha256").update(bytes).digest("hex") } }
  }
  const publish = (version = 1, expires = "2099-01-01T00:00:00Z", signer = online) => {
    const common = { spec_version: "1.0.31", version, expires }
    documents["targets.json"] = envelope({ ...common, _type: "targets", targets: {} }, [signer])
    documents["snapshot.json"] = envelope({ ...common, _type: "snapshot", meta: { "targets.json": binding(documents["targets.json"], version) } }, [signer])
    documents["timestamp.json"] = envelope({ ...common, _type: "timestamp", meta: { "snapshot.json": binding(documents["snapshot.json"], version) } }, [signer])
  }
  publish()
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const filename = new URL(String(input)).pathname.split("/").at(-1)!
    const value = filename.endsWith("root.json") ? roots[filename] : documents[filename.replace(/^\d+\./, "")]
    return value === undefined ? new Response(null, { status: 404 }) : new Response(JSON.stringify(value))
  })
  let trusted: TrustedUpdateDocuments = {}
  const persist = vi.fn(async (next: TrustedUpdateDocuments) => { trusted = next })
  const check = () => fetchUpdateMetadata({ baseUrl: "https://updates.example.test/", trustedRoot: root, trusted, fetcher, persist })
  return { offline, online, rootBody, root, makeRoot, roots, documents, publish, fetcher, persist, check, trusted: () => trusted }
}

describe("daemon update verification", () => {
  afterEach(() => vi.useRealTimers())

  it("accepts standard TUF hex signatures and a 2-of-3 offline root", async () => {
    const repo = fixture()
    expect(await repo.check()).toMatchObject({ "root.json": { signed: { version: 1 } } })
    expect(repo.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/2.root.json", "/timestamp.json", "/1.snapshot.json", "/1.targets.json"])
  })

  it("refuses a root rotation that skips the next trusted version", async () => {
    const repo = fixture()
    repo.roots["2.root.json"] = repo.makeRoot(3)
    await expect(repo.check()).rejects.toMatchObject({ reason: "replay" })
  })

  it("requires distinct old and new root thresholds", async () => {
    const repo = fixture()
    const one = repo.makeRoot(2, [repo.offline[0]!])
    one.signatures.push(one.signatures[0]!)
    repo.roots["2.root.json"] = one
    await expect(repo.check()).rejects.toMatchObject({ reason: "signature" })
    const replacement = keyMaterial(5)
    const newSigned = { ...repo.rootBody, version: 2, keys: {
      ...repo.rootBody.keys, [replacement.keyid]: { keytype: "ed25519", scheme: "ed25519", keyval: { public: replacement.public } },
    }, roles: { ...repo.rootBody.roles, root: { keyids: [replacement.keyid], threshold: 1 } } }
    repo.roots["2.root.json"] = envelope(newSigned, repo.offline.slice(0, 2))
    await expect(repo.check()).rejects.toMatchObject({ reason: "signature" })
    repo.roots["2.root.json"] = envelope(newSigned, [...repo.offline.slice(0, 2), replacement])
    expect(await repo.check()).toMatchObject({ "root.json": { signed: { version: 2 } } })
  })

  it("retains accepted root rotation when later verification fails and resumes from it", async () => {
    const repo = fixture()
    repo.roots["2.root.json"] = repo.makeRoot(2)
    repo.roots["3.root.json"] = repo.makeRoot(3)
    repo.publish(1, "2000-01-01T00:00:00Z")
    await expect(repo.check()).rejects.toMatchObject({ reason: "expired" })
    expect(JSON.parse(repo.trusted().root!).signed.version).toBe(3)
    repo.publish()
    repo.fetcher.mockClear()
    await repo.check()
    expect(new URL(String(repo.fetcher.mock.calls[0]![0])).pathname).toBe("/4.root.json")
  })

  it("rotates an online role only through a threshold-authorized root", async () => {
    const repo = fixture()
    const replacement = keyMaterial(6)
    repo.publish(2, "2099-01-01T00:00:00Z", replacement)
    await expect(repo.check()).rejects.toMatchObject({ reason: "signature" })
    repo.roots["2.root.json"] = envelope({ ...repo.rootBody, version: 2,
      keys: { ...repo.rootBody.keys, [replacement.keyid]: { keytype: "ed25519", scheme: "ed25519", keyval: { public: replacement.public } } },
      roles: { ...repo.rootBody.roles, ...Object.fromEntries(["timestamp", "snapshot", "targets"].map((role) => [role, { keyids: [replacement.keyid], threshold: 1 }])) },
    }, repo.offline.slice(0, 2))
    await expect(repo.check()).resolves.toHaveProperty("targets.json")
  })

  it("rejects expired final root and every expired online role", async () => {
    for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
      const repo = fixture()
      if (role === "root") repo.roots["2.root.json"] = envelope({ ...repo.rootBody, version: 2, expires: "2000-01-01T00:00:00Z" }, repo.offline.slice(0, 2))
      else {
        const current = repo.documents[`${role}.json`] as { signed: Record<string, unknown> }
        repo.documents[`${role}.json`] = envelope({ ...current.signed, expires: "2000-01-01T00:00:00Z" }, [repo.online])
      }
      await expect(repo.check()).rejects.toMatchObject({ reason: "expired" })
    }
  })

  it("refuses replay and same-version changed timestamp bytes after restart", async () => {
    const repo = fixture()
    repo.publish(2)
    await repo.check()
    repo.publish(1)
    await expect(repo.check()).rejects.toMatchObject({ reason: "replay" })
    repo.publish(2, "2098-01-01T00:00:00Z")
    await expect(repo.check()).rejects.toMatchObject({ reason: "replay" })
  })

  it("binds snapshot and targets to their exact served bytes", async () => {
    for (const role of ["snapshot", "targets"]) {
      const repo = fixture()
      const original = repo.fetcher.getMockImplementation()!
      repo.fetcher.mockImplementation(async (input) => {
        const response = await original(input)
        return String(input).endsWith(`${role}.json`) ? new Response(`${await response.text()} `) : response
      })
      await expect(repo.check()).rejects.toMatchObject({ reason: "target-mismatch" })
    }
  })

  it("refuses malformed, oversized and redirected responses", async () => {
    const repo = fixture()
    repo.fetcher.mockImplementationOnce(async () => new Response("not JSON"))
    await expect(repo.check()).rejects.toMatchObject({ reason: "malformed-metadata" })
    repo.fetcher.mockImplementationOnce(async () => new Response(new Uint8Array(maximumUpdateMetadataBytes + 1)))
    await expect(repo.check()).rejects.toMatchObject({ reason: "network" })
    repo.fetcher.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: "https://other.example.test/" } }))
    await expect(repo.check()).rejects.toMatchObject({ reason: "network" })
    expect(repo.fetcher.mock.calls.every((call) => call.length > 0)).toBe(true)
  })

  it("cancels stalled metadata streams at the inactivity deadline", async () => {
    vi.useFakeTimers()
    const repo = fixture()
    const cancel = vi.fn()
    repo.fetcher.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel })))
    const pending = expect(repo.check()).rejects.toMatchObject({ reason: "network" })
    await vi.waitFor(() => expect(repo.fetcher).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(updateInactivityTimeoutMs + 1)
    await pending
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("applies the total deadline even while the metadata stream keeps making progress", async () => {
    vi.useFakeTimers()
    const repo = fixture()
    let interval: ReturnType<typeof setInterval> | undefined
    const cancel = vi.fn(() => clearInterval(interval))
    repo.fetcher.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { interval = setInterval(() => controller.enqueue(new Uint8Array([32])), 1_000) }, cancel,
    })))
    const pending = expect(repo.check()).rejects.toMatchObject({ reason: "network" })
    await vi.waitFor(() => expect(repo.fetcher).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(updateFetchTimeoutMs + 1)
    await pending
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("caps root rotations and refuses persistence failures before fetching more", async () => {
    const repo = fixture()
    for (let version = 2; version < maximumUpdateRootRotations + 3; version++) repo.roots[`${version}.root.json`] = repo.makeRoot(version)
    await repo.check()
    expect(repo.fetcher.mock.calls.filter(([url]) => String(url).endsWith("root.json"))).toHaveLength(maximumUpdateRootRotations)
    repo.persist.mockRejectedValueOnce(new Error("disk failure"))
    repo.fetcher.mockClear()
    await expect(repo.check()).rejects.toMatchObject({ reason: "policy" })
    expect(repo.fetcher).not.toHaveBeenCalled()
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

})
