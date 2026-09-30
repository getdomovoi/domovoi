import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  repositoryTrustResultSchema,
  toolInventorySchema,
  type RepositoryTrustResult,
  type RepositoryTrustState,
  type ToolInventory,
  type ToolInventoryEntry,
  type ToolInventoryProvider,
} from "@getdomovoi/protocol"

import { ToolInventoryView, type ToolInventoryLoad } from "./tool-inventory-view.js"

afterEach(cleanup)

const digest = `sha256:${"a".repeat(64)}`
const changedDigest = `sha256:${"c".repeat(64)}`
const grant = { trustedDigest: digest, trustedAt: "2026-09-12T10:41:00.000Z", trustedBy: { client: "desktop" as const } }
const readAt = new Date("2026-09-29T14:02:31")
const notTrusted: RepositoryTrustState = { state: "untrusted", reason: "not-trusted" }

function entries(heldBack = true): ToolInventoryEntry[] {
  return [
    { kind: "tool-server", file: ".mcp.json", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: ["PGHOST", "PGUSER"], startsAtSessionStart: true, heldBack },
    { kind: "tool-server", file: ".mcp.json", name: "linear", transport: "http", host: "mcp.linear.app:443", envKeys: [], startsAtSessionStart: true, heldBack },
    { kind: "plugin", file: ".claude/settings.json", name: "acme-review@acme-plugins", startsAtSessionStart: true, heldBack },
    { kind: "env-key", file: ".claude/settings.json", key: "ACME_ENV", startsAtSessionStart: true, heldBack },
    { kind: "env-key", file: ".claude/settings.json", key: "DATABASE_URL", startsAtSessionStart: true, heldBack },
    { kind: "hook", file: ".claude/settings.json", event: "SessionStart", command: "./scripts/dev-bootstrap.sh", startsAtSessionStart: true, heldBack },
    { kind: "hook", file: ".claude/settings.json", event: "PostToolUse", matcher: "Edit", command: "./scripts/sync.sh --token [REDACTED]", startsAtSessionStart: false, heldBack },
    { kind: "permission-rule", file: ".claude/settings.json", rule: "allow", detail: "Bash(pnpm test:*)", startsAtSessionStart: false, heldBack },
  ]
}

function claude(overrides: Partial<ToolInventoryProvider> = {}, heldBack = true): ToolInventoryProvider {
  return {
    provider: "claude-code",
    toolServers: "read-from-files",
    omittedEntries: 0,
    files: [
      { path: ".mcp.json", source: "repository-file", state: "read" },
      { path: ".claude/settings.json", source: "project-settings", state: "read" },
      { path: "~/.claude/settings.json", source: "user-settings", state: "read" },
    ],
    entries: [
      ...entries(heldBack),
      { kind: "hook", file: "~/.claude/settings.json", event: "Stop", command: "afplay /System/Library/Sounds/Glass.aiff", startsAtSessionStart: false, heldBack: false },
    ],
    ...overrides,
  }
}

function inventory(
  trust: RepositoryTrustState = notTrusted,
  providers: ToolInventoryProvider[] = [claude()],
  configDigest = trust.state === "untrusted" && trust.reason === "config-changed" ? changedDigest : digest,
): ToolInventory {
  // Every fixture is a message the daemon could send.
  return toolInventorySchema.parse({
    machine: { id: "machine-1", name: "mac-mini-m4", platform: "darwin", arch: "arm64", version: "0.9.4" },
    repository: { projectId: "project-acme", root: "~/src/acme-api", configDigest, trust },
    providers,
  })
}

function loaded(value: ToolInventory): ToolInventoryLoad {
  return { state: "loaded", inventory: value, readAt }
}

function trustResult(value: RepositoryTrustResult): RepositoryTrustResult {
  return repositoryTrustResultSchema.parse(value)
}

type Trust = (params: { projectId: string; configDigest: string }) => Promise<RepositoryTrustResult>

function show(value: ToolInventory, options: { onTrust?: Trust; onRetry?: () => void } = {}) {
  const onRetry = options.onRetry ?? vi.fn()
  const view = render(<ToolInventoryView inventory={loaded(value)} onRetry={onRetry} {...(options.onTrust ? { onTrust: options.onTrust } : {})} />)
  return {
    onRetry,
    rerender: (next: ToolInventoryLoad) => view.rerender(
      <ToolInventoryView inventory={next} onRetry={onRetry} {...(options.onTrust ? { onTrust: options.onTrust } : {})} />,
    ),
  }
}

function heldCard(): HTMLElement {
  return screen.getByRole("region", { name: "acme-api is held back on mac-mini-m4" })
}

async function openSheet(name = "Review and trust") {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name }))
  return { user, sheet: await screen.findByRole("dialog") }
}

describe("held back until trusted", () => {
  it("names the repository held back for every agent, and what still loads", () => {
    show(inventory(), { onTrust: vi.fn() })

    const card = heldCard()
    expect(within(card).getByText("all agents · this machine")).toBeTruthy()
    expect(within(card).getByText("Its hooks, tool servers, plugins, env, rules and git filter do not load for any agent.")).toBeTruthy()
    expect(within(card).getByText((_, element) => element?.tagName === "P" && element.textContent === "CLAUDE.md and AGENTS.md still load.")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Review and trust" })).toBeTruthy()
  })

  it("lists each repository config file with its counts, and no file of the person's own", () => {
    show(inventory(), { onTrust: vi.fn() })

    const files = within(heldCard()).getAllByRole("listitem")
    expect(files.map((file) => file.textContent)).toEqual([
      ".mcp.json2 tool servers",
      ".claude/settings.json2 hooks · 1 plugin · 1 env entry · 1 rule",
    ])
  })

  it("does not say nothing loads when the daemon holds back only some entries", () => {
    const provider = claude({ entries: entries().map((entry) => entry.file === ".mcp.json" ? entry : { ...entry, heldBack: false }) })
    show(inventory(notTrusted, [provider]), { onTrust: vi.fn() })

    const card = heldCard()
    expect(within(card).queryByText(/do not load for any agent/)).toBeNull()
    expect(within(card).getByText("2 of 7 entries from this repository are held back. The rest load.")).toBeTruthy()
  })

  it("draws no held-back card when the repository is trusted, cannot be trusted, or holds nothing back", () => {
    show(inventory({ state: "trusted", ...grant }), { onTrust: vi.fn() })
    expect(screen.queryByRole("region", { name: /is held back on/ })).toBeNull()
    cleanup()

    show(inventory({ state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "nested-config", path: "packages/api/.codex" }], omittedRefusals: 0 }), { onTrust: vi.fn() })
    expect(screen.queryByRole("region", { name: /is held back on/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Review and trust/ })).toBeNull()
    cleanup()

    show(inventory(notTrusted, [claude({}, false)]), { onTrust: vi.fn() })
    expect(screen.queryByRole("region", { name: /is held back on/ })).toBeNull()
  })

  it("offers no trust where this client cannot grant it", () => {
    show(inventory())

    expect(heldCard()).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Review and trust" })).toBeNull()
    expect(within(heldCard()).getByText("Granted from desktop or web only.")).toBeTruthy()
  })
})

describe("trust review sheet", () => {
  it("shows every entry the repository brings, grouped by file, with the config digest and the limits of trust", async () => {
    show(inventory(), { onTrust: vi.fn() })
    const { sheet } = await openSheet()

    expect(within(sheet).getByRole("heading", { name: "Trust acme-api on mac-mini-m4" })).toBeTruthy()
    expect(within(sheet).getByText("Everything this repository would run for any agent here. None of it has run.")).toBeTruthy()

    const mcp = within(sheet).getByRole("group", { name: ".mcp.json" })
    expect(within(mcp).getByText("repository file")).toBeTruthy()
    expect(within(mcp).getByText("postgres-dev")).toBeTruthy()
    expect(within(mcp).getByText("stdio · npx -y @acme/pg-mcp · env keys PGHOST · PGUSER, values not read")).toBeTruthy()
    expect(within(mcp).getByText("http · mcp.linear.app:443")).toBeTruthy()

    const settings = within(sheet).getByRole("group", { name: ".claude/settings.json" })
    expect(within(settings).getByText("project settings")).toBeTruthy()
    expect(within(settings).getByText("acme-review@acme-plugins")).toBeTruthy()
    expect(within(settings).getByText("ACME_ENV · DATABASE_URL")).toBeTruthy()
    expect(within(settings).getByText("Key names only. Values are not shown.")).toBeTruthy()
    expect(within(settings).getByText("SessionStart")).toBeTruthy()
    expect(within(settings).getByText("PostToolUse · Edit")).toBeTruthy()
    expect(within(settings).getByText("Bash(pnpm test:*)")).toBeTruthy()
    // A command the daemon cut says so, and shows nothing past the cut.
    expect(within(settings).getByText("Cut at a credential. Domovoi shows no secret.")).toBeTruthy()

    // The person's own settings are not the repository's to trust.
    expect(within(sheet).queryByText("Stop")).toBeNull()

    expect(within(sheet).getByText("Config digest")).toBeTruthy()
    expect(within(sheet).getByText(digest)).toBeTruthy()
    expect(within(sheet).getByText("Instruction files load either way:")).toBeTruthy()
    expect(within(sheet).getByText("CLAUDE.md · AGENTS.md")).toBeTruthy()
    expect(within(sheet).getByText("Trusted, its hooks run and its tool servers start as you, with your file and network access, when a session opens and before any tool call asks.")).toBeTruthy()
    expect(within(sheet).getByText("Trust is for this machine and this repository only.")).toBeTruthy()
    expect(within(sheet).getByText("It is pinned to one digest of these two files. Any change, an agent's edit included, holds it back again.")).toBeTruthy()
    expect(within(sheet).getByText("Trust does not skip a gate, and its allow rules cannot either. Reads outside the worktree and gated actions still ask.")).toBeTruthy()
    expect(within(sheet).getByText("If they change while this is open, nothing is trusted and the review reloads.")).toBeTruthy()
    expect(within(sheet).getByRole("button", { name: "Trust for this machine" })).toBeTruthy()
    expect(within(sheet).getByRole("button", { name: "Keep held back" })).toBeTruthy()
    expect(within(sheet).getByText("Granted from desktop or web only.")).toBeTruthy()
    expect(within(sheet).getByText("After trust, start the session again.")).toBeTruthy()
  })

  it("names a repository file it could not read, and entries left out, rather than presenting a whole list", async () => {
    const provider = claude({
      omittedEntries: 2,
      files: [
        { path: ".mcp.json", source: "repository-file", state: "read" },
        { path: ".claude/settings.json", source: "project-settings", state: "unreadable", reason: "invalid-json" },
      ],
      entries: entries().filter((entry) => entry.file === ".mcp.json"),
    })
    show(inventory(notTrusted, [provider]), { onTrust: vi.fn() })
    const { sheet } = await openSheet()

    const settings = within(sheet).getByRole("group", { name: ".claude/settings.json" })
    expect(within(settings).getByText("Could not read")).toBeTruthy()
    expect(within(settings).getByText("invalid-json")).toBeTruthy()
    expect(within(settings).getByText("Its entries are not listed. Domovoi does not guess what the file holds.")).toBeTruthy()
    expect(within(sheet).getByText("claude-code: 2 more entries were left out to keep the answer within its size limit. They are not listed here.")).toBeTruthy()
  })

  it("offers no trust while entries the digest covers are left out of the list", async () => {
    const onTrust = vi.fn<Trust>()
    show(inventory(notTrusted, [claude({ omittedEntries: 3 })]), { onTrust })
    const { sheet } = await openSheet()

    // The grant covers the whole configuration, so it would approve entries nobody saw.
    expect(within(sheet).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
    expect(within(sheet).getByText("This list is not complete")).toBeTruthy()
    expect(within(sheet).getByText("3 entries are not shown. Trust is not offered until every entry can be listed.")).toBeTruthy()
    expect(within(sheet).getByRole("button", { name: "Keep held back" })).toBeTruthy()
    expect(onTrust).not.toHaveBeenCalled()
  })

  it("sends the digest the person reviewed, then reads the tools again", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trustResult({
      outcome: "trusted",
      repository: { projectId: "project-acme", configDigest: digest, trust: { state: "trusted", ...grant } },
    }))
    const { onRetry } = show(inventory(), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest })
    expect(onRetry).toHaveBeenCalledOnce()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("keeps it held back without asking the daemon", async () => {
    const onTrust = vi.fn<Trust>()
    show(inventory(), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Keep held back" }))

    expect(onTrust).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("says nothing was trusted when the files changed, reloads, and never retries with the new digest by itself", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trustResult({
      outcome: "config-changed",
      repository: { projectId: "project-acme", configDigest: changedDigest, trust: notTrusted },
    }))
    const { onRetry, rerender } = show(inventory(), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(onTrust).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
    const open = screen.getByRole("dialog")
    expect(within(open).getByText("The files changed while this was open")).toBeTruthy()
    expect(within(open).getByText("Nothing was trusted. Read what they hold now before you trust it.")).toBeTruthy()

    // The reload shows the files as they are now; trusting them is a second decision.
    rerender({ state: "loading" })
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
    rerender(loaded(inventory(notTrusted, [claude()], changedDigest)))
    const reloaded = screen.getByRole("dialog")
    expect(within(reloaded).getByText(changedDigest)).toBeTruthy()
    expect(onTrust).toHaveBeenCalledOnce()

    await user.click(within(reloaded).getByRole("button", { name: "Trust for this machine" }))
    expect(onTrust).toHaveBeenLastCalledWith({ projectId: "project-acme", configDigest: changedDigest })
  })

  it("lists why the repository cannot be trusted when the daemon refuses it", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trustResult({
      outcome: "cannot-trust",
      repository: {
        projectId: "project-acme",
        configDigest: digest,
        trust: { state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "nested-config", path: "packages/api/.codex" }], omittedRefusals: 0 },
      },
    }))
    show(inventory(), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    const open = screen.getByRole("dialog")
    const refusals = within(open).getByRole("region", { name: "acme-api cannot be trusted on this machine" })
    expect(within(refusals).getByText("Agent configuration below the repository root")).toBeTruthy()
    expect(within(refusals).getByText("packages/api/.codex")).toBeTruthy()
    expect(within(open).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
  })

  it("names a failed request and leaves the decision with the person", async () => {
    const onTrust = vi.fn<Trust>().mockRejectedValue(new Error("Only a desktop or web client can trust a repository"))
    const { onRetry } = show(inventory(), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    const open = screen.getByRole("dialog")
    expect(within(open).getByText("Trust was not granted")).toBeTruthy()
    expect(within(open).getByText("Only a desktop or web client can trust a repository")).toBeTruthy()
    expect(within(open).getByRole("button", { name: "Trust for this machine" })).toBeTruthy()
    expect(onTrust).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })
})

describe("changed since trust", () => {
  it("says a trusted file changed and asks for the review again", async () => {
    show(inventory({ state: "untrusted", reason: "config-changed", ...grant }), { onTrust: vi.fn() })

    const card = screen.getByRole("region", { name: "acme-api changed since you trusted it" })
    expect(within(card).getByText(/^trusted \d{2} Sep \d{2}:\d{2} from desktop · no longer applies$/)).toBeTruthy()
    expect(within(card).getByText("A trusted config file changed, so everything the repository brings is held back again.")).toBeTruthy()
    expect(screen.queryByRole("region", { name: /is held back on/ })).toBeNull()

    const { sheet } = await openSheet("Review and trust again")
    expect(within(sheet).getByRole("heading", { name: "Trust acme-api again on mac-mini-m4" })).toBeTruthy()
    expect(within(sheet).getByText(changedDigest)).toBeTruthy()
  })
})
