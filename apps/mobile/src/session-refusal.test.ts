import { repositoryGitFilterErrorCode, type RepositoryGitFilterRefusal, type RepositoryTrustState } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { DaemonError } from "./lib/daemon"
import { phoneRefusalFrom } from "./session-refusal"

const digest = `sha256:${"a".repeat(64)}`

function data(overrides: Partial<RepositoryGitFilterRefusal> = {}): RepositoryGitFilterRefusal {
  return {
    kind: "repository-git-filter",
    projectId: "project-acme",
    configDigest: digest,
    trust: { state: "untrusted", reason: "not-trusted" },
    drivers: [{ name: "sops", scope: "local" }],
    omittedDrivers: 0,
    ...overrides,
  }
}

function refused(overrides: Partial<RepositoryGitFilterRefusal> = {}) {
  return phoneRefusalFrom(new DaemonError("refused", repositoryGitFilterErrorCode, data(overrides)), "acme-api", "studio")
}

describe("phoneRefusalFrom", () => {
  it("reads a session refused over a git filter, with the filter it names", () => {
    expect(refused()).toEqual({
      title: "Domovoi did not start this session",
      code: "refused · untrusted git filter",
      sentence: "Checking out acme-api would run the sops filter driver, which is not trusted on studio.",
      names: ["sops · local git config"],
      omitted: 0,
      awaitsTrust: true,
    })
  })

  it("names several drivers and counts the rest", () => {
    const view = refused({ drivers: [{ name: "sops", scope: "local" }, { name: "crypt", scope: "worktree" }], omittedDrivers: 3 })
    expect(view?.sentence).toBe("Checking out acme-api would run the sops and crypt filter drivers and 3 more, which are not trusted on studio.")
    expect(view?.names).toEqual(["sops · local git config", "crypt · worktree git config"])
    expect(view?.omitted).toBe(3)
  })

  // A trusted refusal: the filters are held back under the trust read now.
  // The refusal does not say why, so the sentence names no cause; trusting
  // again from desktop or web lifts it.
  it("points to trust from desktop or web when the repository is trusted and its filters are held back", () => {
    const trusted: RepositoryTrustState = { state: "trusted", trustedDigest: digest, trustedAt: "2026-09-30T10:41:00Z", trustedBy: { client: "desktop" } }
    const afterTrust = refused({ trust: trusted })
    expect(afterTrust?.awaitsTrust).toBe(true)
    expect(afterTrust?.sentence).toBe("Checking out acme-api would run the sops filter driver. acme-api is trusted on studio, but its Git filters are held back until they are reviewed again.")
  })

  it("does not point to trust where trust cannot lift the refusal", () => {
    const cannot = refused({ trust: { state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "nested-config", path: "a/.codex" }], omittedRefusals: 0 } })
    expect(cannot?.awaitsTrust).toBe(false)
    expect(cannot?.sentence).toBe("Checking out acme-api would run the sops filter driver, and acme-api cannot be trusted on studio.")
  })

  it("leaves any other failure as the daemon's sentence", () => {
    expect(phoneRefusalFrom(new DaemonError("refused", -32603, data()), "acme-api", "studio")).toBeUndefined()
    expect(phoneRefusalFrom(new DaemonError("refused", repositoryGitFilterErrorCode, { kind: "repository-git-filter" }), "acme-api", "studio")).toBeUndefined()
    expect(phoneRefusalFrom(new Error("refused"), "acme-api", "studio")).toBeUndefined()
  })
})
