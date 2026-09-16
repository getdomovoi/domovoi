import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { protocolVersion, updateStatusSchema } from "@getdomovoi/protocol"
import { WebSocket } from "ws"

import { DaemonUpdates, storedUpdatePolicySchema } from "./update-dispatch.js"
import { claimProfile, type ProfileLease } from "./profile-lease.js"
import { canonicalUpdateJson } from "./update-verification.js"
import * as verification from "./update-verification.js"
import { persistTrustedUpdateMetadata, readTrustedUpdateMetadata } from "./update-state.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { DomovoiDaemon } from "./server.js"

const homes: string[] = []
const leases: ProfileLease[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const lease of leases.splice(0)) lease.release()
  await removeScratchDirectories(homes)
})

function signedRepository(options: { version?: number; targetVersion?: string; expires?: string; targetName?: string; minimumUpdaterVersion?: string } = {}) {
  const pair = generateKeyPairSync("ed25519")
  const keyid = "a".repeat(64)
  const envelope = (signed: Record<string, unknown>) => ({ signed, signatures: [{ keyid, sig: sign(null, Buffer.from(canonicalUpdateJson(signed)), pair.privateKey).toString("base64") }] })
  const common = { spec_version: "1.0.31", version: options.version ?? 1, expires: options.expires ?? "2099-01-01T00:00:00.000Z" }
  const root = envelope({ ...common, _type: "root", consistent_snapshot: true,
    keys: { [keyid]: { keytype: "ed25519", scheme: "ed25519", keyval: { public: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") } } },
    roles: Object.fromEntries(["root", "targets", "snapshot", "timestamp"].map((role) => [role, { keyids: [keyid], threshold: 1 }])),
  })
  const version = options.targetVersion ?? "1.2.3"
  const name = options.targetName ?? `getdomovoi-daemon-${version}.tgz`
  const targets = envelope({ ...common, _type: "targets", targets: {
    [name]: { length: 10, hashes: { sha256: "b".repeat(64) }, custom: {
      schemaVersion: 1, version, channel: "stable", sourceCommit: "c".repeat(40), runtimeLockDigest: `sha256:${"d".repeat(64)}`,
      ...(options.minimumUpdaterVersion ? { minimumUpdaterVersion: options.minimumUpdaterVersion } : {}),
    } },
  } })
  const binding = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value))
    return { version: common.version, length: bytes.length, hashes: { sha256: createHash("sha256").update(bytes).digest("hex") } }
  }
  const snapshot = envelope({ ...common, _type: "snapshot", meta: { "targets.json": binding(targets) } })
  const timestamp = envelope({ ...common, _type: "timestamp", meta: { "snapshot.json": binding(snapshot) } })
  const documents: Record<string, unknown> = { "root.json": root, "timestamp.json": timestamp, "snapshot.json": snapshot, "targets.json": targets }
  const fetcher = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(documents[new URL(String(input)).pathname.split("/").at(-1)!])))
  return { root, documents, fetcher }
}

async function setup(repository = signedRepository(), automaticChecks = false) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-update-dispatch-"))
  homes.push(homeDirectory)
  const lease = claimProfile(homeDirectory)
  leases.push(lease)
  const policy = storedUpdatePolicySchema.parse({ format: 1, channel: "stable", automaticChecks,
    metadataBaseUrl: "https://updates.example.test/metadata/", artifactBaseUrl: "https://updates.example.test/artifacts/", trustedRoot: repository.root })
  const policyPath = join(homeDirectory, ".domovoi", "update-policy.json")
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 })
  const install = vi.fn(async (options: { version: string; destination: string; expectedSha256: string }) => ({
    version: options.version, path: join(options.destination, `v${options.version}`), sha256: options.expectedSha256,
  }))
  const options = { homeDirectory, lease, fetcher: repository.fetcher, install }
  return { updates: new DaemonUpdates(options), options, repository, policy, policyPath, install, homeDirectory, lease }
}

describe("daemon update operation", () => {
  it.each(["expired", "signature", "replay", "target-mismatch"] as const)("uses typed %s independent of verifier wording", async (reason) => {
    const { updates } = await setup()
    vi.spyOn(verification, "verifyUpdateChain").mockImplementationOnce(() => {
      throw new verification.UpdateVerificationError(reason, "changed human wording")
    })
    expect(await updates.check()).toMatchObject({ state: "failed", refusal: { reason } })
  })

  it("keeps the verified pending target through a failed refresh", async () => {
    const { updates, repository } = await setup()
    await updates.check()
    repository.fetcher.mockRejectedValueOnce(new Error("offline"))
    const checking = updates.check({ channel: "beta" })
    expect(updates.status()).toMatchObject({ state: "checking" })
    expect(await checking).toMatchObject({ state: "deferred", channel: "stable", pendingVersion: "1.2.3", refusal: { reason: "network" } })
    expect(updates.activate({ version: "1.2.3" })).toMatchObject({ state: "deferred", pendingVersion: "1.2.3", refusal: { reason: "policy" } })
  })

  it("dispatches signed staging and activation refusals over an authenticated socket", async () => {
    const { options, homeDirectory } = await setup()
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", updates: options })
    const address = await daemon.start()
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
    try {
      await once(socket, "open")
      let id = 0
      const call = async (method: string, params: Record<string, unknown> = {}) => {
        const next = once(socket, "message")
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }))
        const [bytes] = await next as [WebSocket.RawData]
        const response = JSON.parse(bytes.toString()) as { result?: unknown; error?: unknown }
        expect(response.error).toBeUndefined()
        return response.result
      }
      await call("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })
      expect(updateStatusSchema.parse(await call("update.check"))).toMatchObject({ state: "pending", pendingVersion: "1.2.3" })
      expect(updateStatusSchema.parse(await call("update.status"))).toMatchObject({ state: "pending" })
      expect(updateStatusSchema.parse(await call("update.activate", { version: "1.2.3" }))).toMatchObject({ state: "deferred", refusal: { reason: "policy" } })
      expect(await readTrustedUpdateMetadata(homeDirectory)).toMatchObject({ targetsVersion: 1 })
    } finally {
      socket.terminate()
      await daemon.stop()
    }
  })

  it("fetches, verifies, stages then persists, and refuses activation with policy", async () => {
    const { updates, install, homeDirectory, repository } = await setup()
    install.mockImplementationOnce(async (options) => {
      expect(await readTrustedUpdateMetadata(homeDirectory)).toMatchObject({ targetsVersion: 0 })
      return { version: options.version, sha256: options.expectedSha256, path: join(options.destination, "v1.2.3") }
    })
    const result = updateStatusSchema.parse(await updates.check())
    expect(result).toMatchObject({ state: "pending", pendingVersion: "1.2.3", pendingSourceCommit: "c".repeat(40) })
    expect(repository.fetcher).toHaveBeenCalledTimes(4)
    expect(install).toHaveBeenCalledWith({ version: "1.2.3", expectedSha256: "b".repeat(64), destination: join(homeDirectory, ".domovoi", "runtimes"), baseUrl: "https://updates.example.test/artifacts/" })
    expect(await readTrustedUpdateMetadata(homeDirectory)).toMatchObject({ rootVersion: 1, timestampVersion: 1, snapshotVersion: 1, targetsVersion: 1 })
    expect(updates.activate({ version: "9.9.9" })).toMatchObject({ state: "failed", refusal: { reason: "target-mismatch" } })
    expect(updates.status()).toEqual(result)
    expect(updates.activate()).toMatchObject({ state: "deferred", pendingVersion: "1.2.3", refusal: { reason: "policy" } })
    expect(updates.activate({ version: "1.2.3" })).toMatchObject({ state: "deferred", refusal: { reason: "policy" } })
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("deduplicates checks, exposes checking, refuses a competing channel and drains on stop", async () => {
    const { updates, install } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    install.mockImplementation(async (options) => {
      await gate
      return { version: options.version, sha256: options.expectedSha256, path: "staged" }
    })
    const first = updates.check()
    expect(updates.check()).toBe(first)
    expect(updates.status().state).toBe("checking")
    expect(await updates.check({ channel: "beta" })).toMatchObject({ state: "failed", refusal: { reason: "busy" } })
    expect(updates.activate()).toMatchObject({ refusal: { reason: "busy" } })
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    let stopped = false
    const stopping = updates.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await first
    await stopping
    expect(await updates.check()).toMatchObject({ refusal: { reason: "policy" } })
    expect(updates.activate()).toMatchObject({ refusal: { reason: "policy" } })
    expect(install).toHaveBeenCalledTimes(1)
  })

  it.each(["root", "timestamp", "snapshot", "targets"] as const)("reads persisted %s versions on restart and refuses replay before installing", async (role) => {
    const { updates, options, install, homeDirectory, lease } = await setup()
    await updates.check()
    const trusted = await readTrustedUpdateMetadata(homeDirectory)
    await persistTrustedUpdateMetadata(homeDirectory, lease, { ...trusted, [`${role}Version`]: 2 })
    install.mockClear()
    const restarted = new DaemonUpdates(options)
    expect(restarted.status().state).toBe("idle")
    expect(restarted.activate()).toMatchObject({ refusal: { reason: "policy" } })
    expect(await restarted.check()).toMatchObject({ state: "failed", refusal: { reason: "replay" } })
    expect(install).not.toHaveBeenCalled()
  })

  it("refuses same-version changed bytes before staging", async () => {
    const { updates, options, install, homeDirectory, repository } = await setup()
    await updates.check()
    const trusted = await readTrustedUpdateMetadata(homeDirectory)
    repository.fetcher.mockImplementation(async (input) => {
      const name = new URL(String(input)).pathname.split("/").at(-1)!
      return new Response(`${JSON.stringify(repository.documents[name])}${name === "root.json" ? "\n" : ""}`)
    })
    install.mockClear()
    expect(await new DaemonUpdates(options).check()).toMatchObject({ refusal: { reason: "replay" } })
    expect(install).not.toHaveBeenCalled()
    expect(await readTrustedUpdateMetadata(homeDirectory)).toEqual(trusted)
  })

  it("persists a verified no-update result without installing", async () => {
    const { updates, install, homeDirectory } = await setup(signedRepository({ targetVersion: "0.0.1" }))
    expect(await updates.check()).toMatchObject({ state: "idle" })
    expect(install).not.toHaveBeenCalled()
    expect(await readTrustedUpdateMetadata(homeDirectory)).toMatchObject({ targetsVersion: 1 })
  })

  it.each([
    { repository: () => signedRepository({ expires: "2000-01-01T00:00:00.000Z" }), reason: "expired" },
    { repository: () => signedRepository({ targetName: "getdomovoi-daemon-9.0.0.tgz" }), reason: "target-mismatch" },
    { repository: () => signedRepository({ minimumUpdaterVersion: "9.0.0" }), reason: "policy" },
  ])("refuses $reason without staging or persisting", async ({ repository, reason }) => {
    const { updates, install, homeDirectory } = await setup(repository())
    expect(await updates.check()).toMatchObject({ state: "failed", refusal: { reason } })
    expect(install).not.toHaveBeenCalled()
    expect(await readTrustedUpdateMetadata(homeDirectory)).toMatchObject({ targetsVersion: 0 })
  })

  it("refuses invalid signatures and malformed metadata without leaking downloaded text", async () => {
    const { updates, repository, install } = await setup()
    repository.documents["targets.json"] = { ...repository.documents["targets.json"] as object, signatures: [{ keyid: "a".repeat(64), sig: "bad" }] }
    expect(await updates.check()).toMatchObject({ refusal: { reason: "signature" } })
    repository.documents["targets.json"] = { privateValue: "do-not-return-downloaded-text" }
    const result = await updates.check()
    expect(result).toMatchObject({ refusal: { reason: "malformed-metadata" } })
    expect(JSON.stringify(result)).not.toContain("do-not-return")
    expect(install).not.toHaveBeenCalled()
  })

  it("does not persist or keep a pending target after a failed install", async () => {
    const { updates, install, homeDirectory } = await setup()
    install.mockRejectedValue(new Error("https://secret:password@example.test/"))
    const result = await updates.check()
    expect(result).toMatchObject({ state: "failed", refusal: { reason: "target-mismatch" } })
    expect(JSON.stringify(result)).not.toContain("password")
    expect(await readTrustedUpdateMetadata(homeDirectory)).toMatchObject({ targetsVersion: 0 })
    expect(updates.activate()).toMatchObject({ refusal: { reason: "policy" } })
  })

  it("revokes pending authority when re-staging that same runtime fails", async () => {
    const { updates, install } = await setup()
    await updates.check()
    install.mockRejectedValueOnce(new Error("staging failed"))
    expect(await updates.check()).toMatchObject({ state: "failed", refusal: { reason: "target-mismatch" } })
    expect(updates.status().pendingVersion).toBeUndefined()
    expect(updates.activate()).toMatchObject({ state: "failed", refusal: { reason: "policy" } })
  })

  it("does not publish pending if metadata persistence fails after staging", async () => {
    const { updates, install, homeDirectory, lease } = await setup()
    install.mockImplementationOnce(async (options) => {
      lease.release()
      return { version: options.version, sha256: options.expectedSha256, path: "staged" }
    })
    expect(await updates.check()).toMatchObject({ state: "failed", refusal: { reason: "policy" } })
    expect(await readTrustedUpdateMetadata(homeDirectory)).toMatchObject({ targetsVersion: 0 })
    expect(updates.activate()).toMatchObject({ refusal: { reason: "policy" } })
  })

  it("refuses unavailable network, malformed policy and corrupt trusted state", async () => {
    const { updates, options, repository, policy, policyPath, homeDirectory, install } = await setup()
    repository.fetcher.mockRejectedValueOnce(new Error("secret URL"))
    expect(await updates.check()).toMatchObject({ refusal: { reason: "network" } })
    await writeFile(policyPath, "{}")
    expect(new DaemonUpdates(options).status()).toMatchObject({ refusal: { reason: "policy" } })
    expect(await updates.check()).toMatchObject({ refusal: { reason: "policy" } })
    await writeFile(policyPath, JSON.stringify(policy))
    await writeFile(join(homeDirectory, ".domovoi", "update-metadata.json"), "{}")
    expect(await updates.check()).toMatchObject({ refusal: { reason: "policy" } })
    expect(install).not.toHaveBeenCalled()
  })
})
