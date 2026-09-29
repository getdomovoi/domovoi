import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  maximumRepositoryTrustRefusals,
  phoneAndTabletRpcMethods,
  repositoryTrustGrantClients,
  repositoryTrustRefusalCodes,
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
const refusal = { provider: "codex", code: "nested-config", path: "packages/api/.codex" } as const
const cannotTrust = { state: "untrusted", reason: "cannot-trust", refusals: [refusal], omittedRefusals: 0 } as const
const record =(trust: unknown, configDigest = reviewed) => ({ projectId: "project-acme", configDigest, trust })

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

  it("names each input the digest does not cover when a repository cannot be trusted", () => {
    expect(repositoryTrustRefusalCodes).toEqual(["nested-config", "main-checkout-hooks", "main-checkout-unknown", "instructions-outside"])
    for (const code of repositoryTrustRefusalCodes) {
      const state = { ...cannotTrust, refusals: [{ ...refusal, code }] }
      expect(repositoryTrustStateSchema.parse(state), code).toEqual(state)
    }
    // It pins to no digest: the input it names is outside what a digest covers.
    expect(repositoryTrustSchema.safeParse(record(cannotTrust, edited)).success).toBe(true)
    expect(repositoryTrustSchema.safeParse(record(cannotTrust)).success).toBe(true)
    const many = Array.from({ length: maximumRepositoryTrustRefusals }, (_, index) => ({ ...refusal, path: `packages/p${index}/.codex` }))
    expect(repositoryTrustStateSchema.safeParse({ ...cannotTrust, refusals: many, omittedRefusals: 3 }).success).toBe(true)
  })

  it("refuses a cannot-trust state that names nothing, too much, or a value", () => {
    const refused = [
      { ...cannotTrust, refusals: [] },
      { ...cannotTrust, refusals: Array.from({ length: maximumRepositoryTrustRefusals + 1 }, () => refusal) },
      { ...cannotTrust, refusals: [{ ...refusal, code: "untrusted-remote" }] },
      { ...cannotTrust, refusals: [{ ...refusal, extra: true }] },
      { ...cannotTrust, refusals: [{ ...refusal, path: "" }] },
      { ...cannotTrust, refusals: [{ ...refusal, path: "x".repeat(1_025) }] },
      { ...cannotTrust, refusals: [{ ...refusal, path: "notes\n.codex" }] },
      { ...cannotTrust, refusals: [{ ...refusal, path: "/tmp/instructions?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] },
      { ...cannotTrust, refusals: [{ ...refusal, provider: "" }] },
      { ...cannotTrust, omittedRefusals: -1 },
      { ...cannotTrust, omittedRefusals: 1.5 },
      { state: "untrusted", reason: "cannot-trust", refusals: [refusal] },
      { ...cannotTrust, trustedDigest: reviewed },
      { ...cannotTrust, state: "trusted" },
    ]
    for (const state of refused) expect(repositoryTrustStateSchema.safeParse(state).success, JSON.stringify(state).slice(0, 200)).toBe(false)
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
    expect(toolInventorySchema.safeParse({ ...inventory, repository: { ...inventory.repository, trust: cannotTrust } }).success).toBe(true)
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

  it("answers cannot-trust for a repository with input its digest does not cover", () => {
    expect(trustMethod.result.safeParse({ outcome: "cannot-trust", repository: record(cannotTrust) }).success).toBe(true)
    for (const trust of [notTrusted, trusted]) {
      expect(trustMethod.result.safeParse({ outcome: "cannot-trust", repository: record(trust) }).success).toBe(false)
    }
    expect(trustMethod.result.safeParse({ outcome: "cannot-trust", repository: record(changed, edited) }).success).toBe(false)
    expect(trustMethod.result.safeParse({ outcome: "trusted", repository: record(cannotTrust) }).success).toBe(false)
    // A stale digest is still answered as config-changed, whatever the current state.
    expect(trustMethod.result.safeParse({ outcome: "config-changed", repository: record(cannotTrust, edited) }).success).toBe(true)
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

  it("reports a repository that cannot be trusted as such after revocation", () => {
    expect(revokeMethod.result.safeParse({ repository: record(cannotTrust), threads: [] }).success).toBe(true)
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
