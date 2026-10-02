import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  repositoryGitFilterErrorCode,
  repositoryGitFilterRefusalSchema,
  repositoryTrustResultSchema,
  toolInventorySchema,
  type RepositoryGitFilterRefusal,
  type RepositoryTrustResult,
  type RepositoryTrustState,
  type ToolInventory,
} from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"
import { SessionRefusalCard } from "./session-refusal-card.js"
import { gitFilterRefusalFrom } from "./session-refusal.js"

afterEach(cleanup)

const digest = `sha256:${"a".repeat(64)}`
const changedDigest = `sha256:${"c".repeat(64)}`
// tool.inventory's digest over the git filter block it lists.
const reviewDigest = `sha256:${"b".repeat(64)}`
const grant = { trustedDigest: digest, trustedAt: "2026-09-30T10:41:00.000Z", trustedBy: { client: "desktop" as const } }
const notTrusted: RepositoryTrustState = { state: "untrusted", reason: "not-trusted" }

function refusal(overrides: Partial<RepositoryGitFilterRefusal> = {}): RepositoryGitFilterRefusal {
  // Every fixture is an answer the daemon could send.
  return repositoryGitFilterRefusalSchema.parse({
    kind: "repository-git-filter",
    projectId: "project-acme",
    configDigest: digest,
    trust: notTrusted,
    drivers: [{ name: "sops", scope: "local" }],
    omittedDrivers: 0,
    ...overrides,
  })
}

function inventory(configDigest = digest, trust: RepositoryTrustState = notTrusted): ToolInventory {
  return toolInventorySchema.parse({
    machine: { id: "machine-1", name: "mac-mini-m4", platform: "darwin", arch: "arm64", version: "0.9.4" },
    repository: {
      projectId: "project-acme",
      root: "~/src/acme-api",
      configDigest,
      trust,
      gitFilters: {
        files: [{ path: ".git/config", scope: "local" }],
        entries: [
          { driver: "sops", operation: "smudge", command: "sops -d", required: "true", file: ".git/config", scope: "local", heldBack: true },
          { driver: "sops", operation: "clean", command: "sops -e", required: "true", file: ".git/config", scope: "local", heldBack: true },
        ],
        omittedEntries: 0,
        reviewDigest,
      },
    },
    providers: [],
  })
}

type Trust = (params: { projectId: string; configDigest: string }) => Promise<RepositoryTrustResult>

function trusted(): RepositoryTrustResult {
  return repositoryTrustResultSchema.parse({
    outcome: "trusted",
    repository: { projectId: "project-acme", configDigest: digest, trust: { state: "trusted", ...grant } },
  })
}

function show(options: {
  refusal?: RepositoryGitFilterRefusal
  onTrust?: Trust
  loadInventory?: (signal: AbortSignal) => Promise<ToolInventory>
  onStartAgain?: () => Promise<void>
} = {}) {
  const props = {
    refusal: options.refusal ?? refusal(),
    repository: "acme-api",
    machine: "mac-mini-m4",
    loadInventory: options.loadInventory ?? vi.fn(async () => inventory()),
    onOpenTools: vi.fn(),
    onStartAgain: options.onStartAgain ?? vi.fn(async () => {}),
    onClose: vi.fn(),
  }
  render(<SessionRefusalCard {...props} {...(options.onTrust ? { onTrust: options.onTrust } : {})} />)
  return { ...props, user: userEvent.setup(), card: screen.getByRole("region", { name: "Domovoi did not start this session" }) }
}

describe("reading a refusal", () => {
  it("reads the git filter refusal from the daemon's error, and nothing else", () => {
    const data = refusal()
    expect(gitFilterRefusalFrom(new DaemonRpcError(repositoryGitFilterErrorCode, "refused", data))).toEqual(data)
    // Another code, or data the protocol refuses, is an ordinary failure.
    expect(gitFilterRefusalFrom(new DaemonRpcError(-32603, "refused", data))).toBeUndefined()
    expect(gitFilterRefusalFrom(new DaemonRpcError(repositoryGitFilterErrorCode, "refused", { kind: "repository-git-filter" }))).toBeUndefined()
    expect(gitFilterRefusalFrom(new Error("refused"))).toBeUndefined()
  })
})

describe("session refused for an untrusted git filter", () => {
  it("names who refused, the reason code, the filter it names and that nothing ran", () => {
    const { card } = show({ onTrust: vi.fn<Trust>() })

    expect(within(card).getByRole("heading", { name: "Domovoi did not start this session" })).toBeTruthy()
    expect(within(card).getByText("refused · untrusted git filter")).toBeTruthy()
    expect(within(card).getByText("Checking out acme-api would run the sops filter driver, which is not trusted on mac-mini-m4.")).toBeTruthy()
    expect(within(card).getByText("It names")).toBeTruthy()
    expect(within(card).getByText("sops · local git config")).toBeTruthy()
    expect(within(card).getByText("Nothing from the repository ran.")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Review and trust" })).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Open Tools" })).toBeTruthy()
    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  it("names several drivers and counts the ones the daemon did not name", () => {
    const { card } = show({
      refusal: refusal({ drivers: [{ name: "sops", scope: "local" }, { name: "crypt", scope: "worktree" }], omittedDrivers: 2 }),
    })

    expect(within(card).getByText("Checking out acme-api would run the sops and crypt filter drivers and 2 more, which are not trusted on mac-mini-m4.")).toBeTruthy()
    expect(within(card).getByText("sops · local git config")).toBeTruthy()
    expect(within(card).getByText("crypt · worktree git config")).toBeTruthy()
    expect(within(card).getByText("and 2 more")).toBeTruthy()
  })

  it("says where trust is granted on a client that cannot grant it, and still opens Tools", async () => {
    const { card, user, onOpenTools } = show()

    expect(within(card).queryByRole("button", { name: "Review and trust" })).toBeNull()
    expect(within(card).getByText("Granted from desktop or web only.")).toBeTruthy()
    await user.click(within(card).getByRole("button", { name: "Open Tools" }))
    expect(onOpenTools).toHaveBeenCalledOnce()
  })

  it("offers no trust when the repository cannot be trusted", () => {
    const { card } = show({
      onTrust: vi.fn<Trust>(),
      refusal: refusal({ trust: { state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "nested-config", path: "packages/api/.codex" }], omittedRefusals: 0 } }),
    })

    expect(within(card).getByText("Checking out acme-api would run the sops filter driver, and acme-api cannot be trusted on mac-mini-m4.")).toBeTruthy()
    expect(within(card).queryByRole("button", { name: "Review and trust" })).toBeNull()
    expect(within(card).getByRole("button", { name: "Open Tools" })).toBeTruthy()
  })

  // A trusted refusal: the grant covers the configuration, but its client did
  // not show the git filters, or the ones shown are not the ones read now
  // (filters-not-reviewed, filters-changed). Trusting again from a client that
  // shows them settles it.
  it("says the filters stay held back until they are reviewed when the repository is trusted", () => {
    const { card } = show({ onTrust: vi.fn<Trust>(), refusal: refusal({ trust: { state: "trusted", ...grant } }) })

    expect(within(card).getByText("Checking out acme-api would run the sops filter driver. acme-api is trusted on mac-mini-m4, but its Git filters stay held back until they are reviewed: they were not shown when it was trusted, or they changed since.")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Review and trust again" })).toBeTruthy()
    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  it("says where trust is granted for a trusted refusal on a client that cannot grant it", () => {
    const { card } = show({ refusal: refusal({ trust: { state: "trusted", ...grant } }) })

    expect(within(card).queryByRole("button", { name: "Review and trust again" })).toBeNull()
    expect(within(card).getByText("Granted from desktop or web only.")).toBeTruthy()
  })
})

describe("review and trust from the refusal", () => {
  it("opens the one trust sheet over the files read now, and after trust offers to start again without starting", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trusted())
    const loadInventory = vi.fn(async () => inventory())
    const onStartAgain = vi.fn(async () => {})
    const { card, user } = show({ onTrust, loadInventory, onStartAgain })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    expect(loadInventory).toHaveBeenCalledOnce()
    expect(within(sheet).getByRole("heading", { name: "Trust acme-api on mac-mini-m4" })).toBeTruthy()
    expect(await within(sheet).findByText("smudge sops -d · clean sops -e")).toBeTruthy()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    // The grant acknowledges the git filters the sheet showed (#688).
    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest, gitFilters: { reviewed: true, reviewDigest } })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(within(card).getByText("Trusted on mac-mini-m4. Nothing has started yet.")).toBeTruthy()
    // The refusal no longer says the filter is not trusted.
    expect(within(card).getByText("Checking out acme-api would run the sops filter driver.")).toBeTruthy()
    expect(within(card).queryByText(/is not trusted on/)).toBeNull()
    expect(within(card).queryByRole("button", { name: "Review and trust" })).toBeNull()
    // The session never starts by itself (ruling Q202 A).
    expect(onStartAgain).not.toHaveBeenCalled()

    await user.click(within(card).getByRole("button", { name: "Start the session again" }))
    expect(onStartAgain).toHaveBeenCalledOnce()
  })

  it("reviews and trusts again from a trusted refusal, acknowledging the filters it shows", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trusted())
    const loadInventory = vi.fn(async () => inventory(digest, { state: "trusted", ...grant }))
    const { card, user } = show({ onTrust, loadInventory, refusal: refusal({ trust: { state: "trusted", ...grant } }) })

    await user.click(within(card).getByRole("button", { name: "Review and trust again" }))
    const sheet = await screen.findByRole("dialog")
    expect(await within(sheet).findByRole("heading", { name: "Trust acme-api again on mac-mini-m4" })).toBeTruthy()
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest, gitFilters: { reviewed: true, reviewDigest } })
    expect(within(card).getByText("Trusted on mac-mini-m4. Nothing has started yet.")).toBeTruthy()
    expect(within(card).getByText("Checking out acme-api would run the sops filter driver.")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Start the session again" })).toBeTruthy()
  })

  it("keeps the refusal when the files changed while the sheet was open, and reads them again", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(repositoryTrustResultSchema.parse({
      outcome: "config-changed",
      repository: { projectId: "project-acme", configDigest: changedDigest, trust: notTrusted },
    }))
    const loadInventory = vi.fn<(signal: AbortSignal) => Promise<ToolInventory>>()
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(inventory(changedDigest))
    const { card, user } = show({ onTrust, loadInventory })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    await within(sheet).findByText(digest)
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(within(screen.getByRole("dialog")).getByText("The files changed while this was open")).toBeTruthy()
    expect(await within(screen.getByRole("dialog")).findByText(changedDigest)).toBeTruthy()
    expect(loadInventory).toHaveBeenCalledTimes(2)
    expect(within(card).queryByText(/Nothing has started yet/)).toBeNull()
    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  it("does not count a grant for another project as lifting this refusal", async () => {
    const other = repositoryTrustResultSchema.parse({
      outcome: "trusted",
      repository: { projectId: "project-other", configDigest: digest, trust: { state: "trusted", ...grant } },
    })
    const { card, user } = show({ onTrust: vi.fn<Trust>().mockResolvedValue(other) })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    await within(sheet).findByText(digest)
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  it("names a start that failed for another reason and leaves the retry with the person", async () => {
    const onStartAgain = vi.fn(async () => { throw new Error("The provider is not ready") })
    const { card, user } = show({ onTrust: vi.fn<Trust>().mockResolvedValue(trusted()), onStartAgain })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    await within(sheet).findByText(digest)
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))
    await user.click(within(card).getByRole("button", { name: "Start the session again" }))

    expect(within(card).getByText("The provider is not ready")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Start the session again" })).toBeTruthy()
    expect(onStartAgain).toHaveBeenCalledOnce()
  })
})
