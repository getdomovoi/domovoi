import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  phoneAndTabletRpcMethods,
  repositoryTrustGrantClients,
  repositoryTrustRpcMethods,
  repositoryTrustSchema,
  repositoryTrustStateSchema,
  rpcMethodAuthorizations,
  rpcMethodMutations,
  rpcMethods,
  toolInventorySchema,
} from "./index.js"

const reviewed = `sha256:${"a".repeat(64)}`
const edited = `sha256:${"b".repeat(64)}`
const trustedBy = { client: "desktop", clientId: "client-studio" } as const
const trusted = { state: "trusted", trustedDigest: reviewed, trustedAt: "2026-09-26T10:00:00Z", trustedBy } as const
const changed = { ...trusted, state: "untrusted", reason: "config-changed" } as const
const notTrusted = { state: "untrusted", reason: "not-trusted" } as const
const record = (trust: unknown, configDigest = reviewed) => ({ projectId: "project-acme", configDigest, trust })

const trustMethod = rpcMethods["repository.trust"]
const revokeMethod = rpcMethods["repository.revokeTrust"]
const trustParams = { projectId: "project-acme", configDigest: reviewed, client: "desktop" } as const
const revokeParams = { projectId: "project-acme", client: "web" } as const

describe("repository trust state", () => {
  it("is trusted, not trusted, or changed since it was trusted", () => {
    for (const state of [notTrusted, trusted, changed]) {
      expect(repositoryTrustStateSchema.parse(state)).toEqual(state)
    }
    expect(repositoryTrustStateSchema.safeParse({ state: "untrusted" }).success).toBe(false)
    expect(repositoryTrustStateSchema.safeParse({ state: "changed" }).success).toBe(false)
    expect(repositoryTrustStateSchema.safeParse({ ...notTrusted, trustedDigest: reviewed }).success).toBe(false)
    const { trustedDigest: _, ...unpinned } = trusted
    expect(repositoryTrustStateSchema.safeParse(unpinned).success).toBe(false)
    expect(repositoryTrustStateSchema.safeParse({ ...trusted, extra: true }).success).toBe(false)
  })

  it("pins trust to the configuration digest it covers", () => {
    expect(repositoryTrustSchema.safeParse(record(trusted)).success).toBe(true)
    // A trust recorded for another digest is no longer trust.
    expect(repositoryTrustSchema.safeParse(record(trusted, edited)).success).toBe(false)
    expect(repositoryTrustSchema.safeParse(record(changed, edited)).success).toBe(true)
    expect(repositoryTrustSchema.safeParse(record(changed)).success).toBe(false)
    expect(repositoryTrustSchema.safeParse(record(notTrusted, edited)).success).toBe(true)
  })

  it("accepts only a sha256 digest", () => {
    for (const digest of ["sha256:abc", `sha256:${"A".repeat(64)}`, `sha1:${"a".repeat(40)}`, "a".repeat(64), `sha256:${"a".repeat(65)}`]) {
      expect(repositoryTrustSchema.safeParse(record(notTrusted, digest)).success, digest).toBe(false)
      expect(repositoryTrustStateSchema.safeParse({ ...trusted, trustedDigest: digest }).success, digest).toBe(false)
      expect(trustMethod.params.safeParse({ ...trustParams, configDigest: digest }).success, digest).toBe(false)
    }
  })

  it("caps the grant time before reading it as a timestamp", () => {
    expect(repositoryTrustStateSchema.safeParse({ ...trusted, trustedAt: "2026-09-26T10:00:00.123456789+05:30" }).success).toBe(true)
    expect(repositoryTrustStateSchema.safeParse({ ...trusted, trustedAt: `2026-09-26T10:00:00.${"1".repeat(1_000_000)}Z` }).success).toBe(false)
    expect(repositoryTrustStateSchema.safeParse({ ...changed, trustedAt: `2026-09-26T10:00:00.${"1".repeat(64)}Z` }).success).toBe(false)
  })

  it("records a grant from desktop or web only", () => {
    expect(repositoryTrustGrantClients).toEqual(["desktop", "web"])
    for (const client of ["phone", "tablet", "cli"]) {
      expect(repositoryTrustStateSchema.safeParse({ ...trusted, trustedBy: { client } }).success, client).toBe(false)
    }
    expect(repositoryTrustStateSchema.safeParse({ ...trusted, trustedBy: { client: "web" } }).success).toBe(true)
  })

  it("travels with the tool inventory's repository", () => {
    const inventory = {
      machine: { id: "machine-studio", name: "studio", platform: "darwin", arch: "arm64", version: "0.9.4" },
      repository: { projectId: "project-acme", root: "/Users/ada/src/acme-api", configDigest: reviewed, trust: trusted },
      providers: [],
    }
    expect(toolInventorySchema.safeParse(inventory).success).toBe(true)
    expect(toolInventorySchema.safeParse({ ...inventory, repository: { ...inventory.repository, configDigest: edited } }).success).toBe(false)
    const { trust: _, ...withoutTrust } = inventory.repository
    expect(toolInventorySchema.safeParse({ ...inventory, repository: withoutTrust }).success).toBe(false)
  })
})

describe("repository.trust", () => {
  it("trusts the digest the client reviewed, for this machine", () => {
    expect(trustMethod.params.parse(trustParams)).toEqual(trustParams)
    expect(trustMethod.params.safeParse({ ...trustParams, client: "web" }).success).toBe(true)
    const { configDigest: _, ...undigested } = trustParams
    expect(trustMethod.params.safeParse(undigested).success).toBe(false)
    expect(trustMethod.params.safeParse({ ...trustParams, projectId: "" }).success).toBe(false)
    expect(trustMethod.params.safeParse({ ...trustParams, projectId: "x".repeat(257) }).success).toBe(false)
  })

  it("refuses a phone, tablet or command-line grant", () => {
    for (const client of ["phone", "tablet", "cli"]) {
      expect(trustMethod.params.safeParse({ ...trustParams, client }).success, client).toBe(false)
      expect(revokeMethod.params.safeParse({ ...revokeParams, client }).success, client).toBe(false)
    }
  })

  it("has no field for another machine, the fleet, or a hard gate", () => {
    for (const extra of [{ machineId: "machine-2" }, { scope: "fleet" }, { hardGates: false }, { skipHardGates: true }, { autoApprove: true }]) {
      expect(trustMethod.params.safeParse({ ...trustParams, ...extra }).success, JSON.stringify(extra)).toBe(false)
      expect(revokeMethod.params.safeParse({ ...revokeParams, ...extra }).success, JSON.stringify(extra)).toBe(false)
    }
  })

  it("answers trusted, or that the configuration changed since review", () => {
    expect(trustMethod.result.safeParse({ outcome: "trusted", repository: record(trusted) }).success).toBe(true)
    expect(trustMethod.result.safeParse({ outcome: "trusted", repository: record(notTrusted) }).success).toBe(false)
    expect(trustMethod.result.safeParse({ outcome: "trusted", repository: record(changed, edited) }).success).toBe(false)
    expect(trustMethod.result.safeParse({ outcome: "config-changed", repository: record(changed, edited) }).success).toBe(true)
    expect(trustMethod.result.safeParse({ outcome: "config-changed", repository: record(notTrusted, edited) }).success).toBe(true)
    expect(trustMethod.result.safeParse({ outcome: "config-changed", repository: record(trusted) }).success).toBe(true)
    expect(trustMethod.result.safeParse({ outcome: "trusted", repository: record(trusted), extra: true }).success).toBe(false)
  })
})

describe("repository.revokeTrust", () => {
  it("names the repository and nothing else", () => {
    expect(revokeMethod.params.parse(revokeParams)).toEqual(revokeParams)
    expect(revokeMethod.params.safeParse({ ...revokeParams, configDigest: reviewed }).success).toBe(false)
  })

  it("leaves the repository not trusted and reports each thread it restarted", () => {
    const threads = [
      { sessionId: "session-1", outcome: "restarted" },
      { sessionId: "session-2", outcome: "unconfirmed" },
    ]
    expect(revokeMethod.result.safeParse({ repository: record(notTrusted), threads }).success).toBe(true)
    expect(revokeMethod.result.safeParse({ repository: record(notTrusted), threads: [] }).success).toBe(true)
    expect(revokeMethod.result.safeParse({ repository: record(trusted), threads: [] }).success).toBe(false)
    expect(revokeMethod.result.safeParse({ repository: record(changed, edited), threads: [] }).success).toBe(false)
    expect(revokeMethod.result.safeParse({ repository: record(notTrusted) }).success).toBe(false)
    expect(revokeMethod.result.safeParse({ repository: record(notTrusted), threads: [threads[0], threads[0]] }).success).toBe(false)
    expect(revokeMethod.result.safeParse({ repository: record(notTrusted), threads: [{ sessionId: "session-1", outcome: "skipped" }] }).success).toBe(false)
  })
})

describe("repository trust methods", () => {
  it.each(["repository.trust", "repository.revokeTrust"] as const)("%s is a mutating control method the phone does not get", (method) => {
    expect(rpcMethodAuthorizations[method]).toBe("control")
    expect(rpcMethodMutations[method]).toBe("mutating")
    expect(phoneAndTabletRpcMethods.has(method)).toBe(false)
  })

  it("names the trust methods for the daemon's credential check", () => {
    expect([...repositoryTrustRpcMethods].sort()).toEqual(["repository.revokeTrust", "repository.trust"])
    expect(Object.keys(rpcMethods).filter((method) => method.startsWith("repository.")).sort()).toEqual([...repositoryTrustRpcMethods].sort())
    for (const method of repositoryTrustRpcMethods) expect(phoneAndTabletRpcMethods.has(method)).toBe(false)
  })

  it.each(["repository.trust", "repository.revokeTrust"] as const)("%s never reads a workspace snapshot as its answer", (method) => {
    expect(rpcMethods[method].result.safeParse(demoWorkspace).success).toBe(false)
  })
})
