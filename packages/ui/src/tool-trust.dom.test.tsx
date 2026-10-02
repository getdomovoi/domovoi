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
  type ToolInventoryGitFilters,
  type ToolInventoryProvider,
} from "@getdomovoi/protocol"

import { ToolInventoryView, type ToolInventoryLoad } from "./tool-inventory-view.js"

afterEach(cleanup)

const digest = `sha256:${"a".repeat(64)}`
const changedDigest = `sha256:${"c".repeat(64)}`
// tool.inventory's digest over the git filter block it lists.
const reviewDigest = `sha256:${"b".repeat(64)}`
const gitConfigPinnedText = "In the Git config only the filter settings listed here are pinned, not the whole file: changing one of them, or the file that sets it, holds them back again. Other Git settings in that file are not pinned."
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

  it("draws no trust card when the repository is trusted, cannot be trusted, or brings no config file", () => {
    show(inventory({ state: "trusted", ...grant }), { onTrust: vi.fn() })
    expect(screen.queryByRole("region", { name: /is held back on/ })).toBeNull()
    cleanup()

    show(inventory({ state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "nested-config", path: "packages/api/.codex" }], omittedRefusals: 0 }), { onTrust: vi.fn() })
    expect(screen.queryByRole("region", { name: /is held back on/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Review and trust/ })).toBeNull()
    cleanup()

    const none = claude({ files: [{ path: ".mcp.json", source: "repository-file", state: "absent" }], entries: [] })
    show(inventory(notTrusted, [none]), { onTrust: vi.fn() })
    expect(screen.queryByRole("region", { name: /on mac-mini-m4$/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Review and trust/ })).toBeNull()
  })

  it("still offers trust when the daemon holds none of the repository's entries back, without calling them held back", async () => {
    show(inventory(notTrusted, [claude({}, false)]), { onTrust: vi.fn() })

    expect(screen.queryByRole("region", { name: /is held back on/ })).toBeNull()
    const card = screen.getByRole("region", { name: "acme-api is not trusted on mac-mini-m4" })
    expect(within(card).getByText("0 of 7 entries from this repository are held back. The rest load.")).toBeTruthy()
    const { sheet } = await openSheet()
    expect(within(sheet).getByRole("button", { name: "Trust for this machine" })).toBeTruthy()
  })

  it("offers trust for config files that declare no entries, and shows each file", async () => {
    // Codex refuses a repository holding only .codex rules or an empty
    // config.toml; the inventory lists and digests those files without a row.
    const codex: ToolInventoryProvider = {
      provider: "codex",
      toolServers: "none-passed",
      omittedEntries: 0,
      files: [
        { path: ".codex/config.toml", source: "project-settings", state: "empty" },
        { path: ".codex/rules/default.rules", source: "project-settings", state: "read" },
      ],
      entries: [],
    }
    const onTrust = vi.fn<Trust>().mockResolvedValue(trustResult({
      outcome: "trusted",
      repository: { projectId: "project-acme", configDigest: digest, trust: { state: "trusted", ...grant } },
    }))
    show(inventory(notTrusted, [codex]), { onTrust })

    const card = heldCard()
    expect(within(card).getAllByRole("listitem").map((file) => file.textContent)).toEqual([
      ".codex/config.tomlno entries",
      ".codex/rules/default.rulesno entries",
    ])
    const { user, sheet } = await openSheet()
    for (const path of [".codex/config.toml", ".codex/rules/default.rules"]) {
      expect(within(within(sheet).getByRole("group", { name: path })).getByText("no entries")).toBeTruthy()
    }
    expect(within(sheet).getByText("It is pinned to one digest of these two files. Any change, an agent's edit included, holds it back again.")).toBeTruthy()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))
    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest })
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

  it("does not say none of it has run when the daemon holds back only some entries", async () => {
    const provider = claude({ entries: entries().map((entry) => entry.file === ".mcp.json" ? entry : { ...entry, heldBack: false }) })
    show(inventory(notTrusted, [provider]), { onTrust: vi.fn() })
    const { sheet } = await openSheet()

    expect(within(sheet).queryByText("Everything this repository would run for any agent here. None of it has run.")).toBeNull()
    expect(within(sheet).getByText("2 of 7 entries from this repository are held back. The rest already load.")).toBeTruthy()
  })

  it("offers no trust while a repository config file could not be read", async () => {
    const onTrust = vi.fn<Trust>()
    const provider = claude({
      files: [
        { path: ".mcp.json", source: "repository-file", state: "read" },
        { path: ".claude/settings.json", source: "project-settings", state: "unreadable", reason: "invalid-json" },
      ],
      entries: entries().filter((entry) => entry.file === ".mcp.json"),
    })
    show(inventory(notTrusted, [provider]), { onTrust })
    const { sheet } = await openSheet()

    // The digest covers the file, so a grant would approve what nobody could read.
    expect(within(sheet).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
    expect(within(sheet).getByText("This list is not complete")).toBeTruthy()
    expect(within(sheet).getByText(".claude/settings.json could not be read. Trust is not offered until it can be read.")).toBeTruthy()
    expect(within(sheet).getByRole("button", { name: "Keep held back" })).toBeTruthy()
    expect(onTrust).not.toHaveBeenCalled()
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

// The repository's own Git config sets a filter driver: tool.inventory lists
// each driver's commands by the file and scope Git read them in.
const sopsFilters: ToolInventoryGitFilters = {
  files: [{ path: ".git/config", scope: "local" }],
  entries: [
    { driver: "sops", operation: "smudge", command: "sops -d", required: "true", file: ".git/config", scope: "local", heldBack: true },
    { driver: "sops", operation: "clean", command: "sops -e", required: "true", file: ".git/config", scope: "local", heldBack: true },
  ],
  omittedEntries: 0,
  reviewDigest,
}

function withGitFilters(value: ToolInventory, gitFilters: ToolInventoryGitFilters): ToolInventory {
  return toolInventorySchema.parse({ ...value, repository: { ...value.repository, gitFilters } })
}

describe("git filters in the review", () => {
  it("lists the filter's config file in the held back card, with its count", () => {
    show(withGitFilters(inventory(), sopsFilters), { onTrust: vi.fn() })

    expect(within(heldCard()).getAllByRole("listitem").map((file) => file.textContent)).toEqual([
      ".mcp.json2 tool servers",
      ".claude/settings.json2 hooks · 1 plugin · 1 env entry · 1 rule",
      ".git/config1 filter driver",
    ])
  })

  it("offers trust for a repository whose only config is a git filter", async () => {
    const none = claude({ files: [{ path: ".mcp.json", source: "repository-file", state: "absent" }], entries: [] })
    show(withGitFilters(inventory(notTrusted, [none]), sopsFilters), { onTrust: vi.fn() })

    const card = heldCard()
    expect(within(card).getByText("Its hooks, tool servers, plugins, env, rules and git filter do not load for any agent.")).toBeTruthy()
    const { sheet } = await openSheet()
    expect(within(sheet).getByText("Everything this repository would run for any agent here. None of it has run.")).toBeTruthy()
    expect(within(sheet).getByRole("button", { name: "Trust for this machine" })).toBeTruthy()
    // The digest pins the reviewed filter settings, not the whole Git config
    // file, so the sheet does not promise that any change to it counts.
    expect(within(sheet).queryByText(/^It is pinned to one digest of/u)).toBeNull()
    expect(within(sheet).getByText(gitConfigPinnedText)).toBeTruthy()
  })

  it("shows a group per git config file and scope, each driver with its operations and redacted commands", async () => {
    const filters: ToolInventoryGitFilters = {
      files: [{ path: ".git/config", scope: "local" }, { path: ".git/worktrees/w1/config.worktree", scope: "worktree" }],
      entries: [
        ...sopsFilters.entries,
        { driver: "crypt", operation: "process", command: "./bin/crypt --token [REDACTED]", commandHidden: true, required: "unset", file: ".git/worktrees/w1/config.worktree", scope: "worktree", heldBack: true },
      ],
      omittedEntries: 0,
      reviewDigest,
    }
    show(withGitFilters(inventory(), filters), { onTrust: vi.fn() })
    const { sheet } = await openSheet()

    const local = within(sheet).getByRole("group", { name: ".git/config" })
    expect(within(local).getByText("local git config")).toBeTruthy()
    expect(within(local).getByText("1 filter driver")).toBeTruthy()
    expect(within(local).getByText("Filter driver")).toBeTruthy()
    expect(within(local).getByText("sops")).toBeTruthy()
    expect(within(local).getByText("smudge sops -d · clean sops -e")).toBeTruthy()
    // A trusted filter runs whatever its command names (ruling Q205 A).
    expect(within(local).getByText("A filter driver runs its command whenever Git checks out or stages a file. If the command runs a file in this repository, it runs whatever that file holds, an agent's edit included.")).toBeTruthy()

    const worktree = within(sheet).getByRole("group", { name: ".git/worktrees/w1/config.worktree" })
    expect(within(worktree).getByText("worktree git config")).toBeTruthy()
    expect(within(worktree).getByText("crypt")).toBeTruthy()
    expect(within(worktree).getByText("process ./bin/crypt --token [REDACTED]")).toBeTruthy()
    expect(within(worktree).getByText("Cut at a credential. Domovoi shows no secret.")).toBeTruthy()

    // Provider files are pinned whole; the Git config only by its filter settings.
    expect(within(sheet).getByText("It is pinned to one digest of these two files. Any change, an agent's edit included, holds it back again.")).toBeTruthy()
    expect(within(sheet).getByText(gitConfigPinnedText)).toBeTruthy()
  })

  // The review digest covers each driver's required state, so the review
  // shows it: it decides whether Git keeps unfiltered bytes when the filter fails.
  it("shows each driver's required state", async () => {
    const filters: ToolInventoryGitFilters = {
      files: [{ path: ".git/config", scope: "local" }],
      entries: [
        ...sopsFilters.entries,
        { driver: "crypt", operation: "process", command: "./bin/crypt", required: "unset", file: ".git/config", scope: "local", heldBack: true },
        { driver: "lock", operation: "clean", command: "./bin/lock", required: "false", file: ".git/config", scope: "local", heldBack: true },
      ],
      omittedEntries: 0,
      reviewDigest,
    }
    show(withGitFilters(inventory(), filters), { onTrust: vi.fn() })
    const { sheet } = await openSheet()

    const rows = within(within(sheet).getByRole("group", { name: ".git/config" })).getAllByRole("listitem")
    expect(rows.map((row) => within(row).getAllByText(/^required is /u).map((line) => line.textContent))).toEqual([
      ["required is true: if the filter fails, the Git command fails."],
      ["required is not set: if the filter fails, Git stores or checks out the file unfiltered."],
      ["required is false: if the filter fails, Git stores or checks out the file unfiltered."],
    ])
  })

  it("offers no trust while the repository's Git config could not be read", async () => {
    const onTrust = vi.fn<Trust>()
    show(withGitFilters(inventory(), { files: [], entries: [], omittedEntries: 0, unreadable: { reason: "git-failed" }, reviewDigest }), { onTrust })

    expect(within(heldCard()).getAllByRole("listitem").at(-1)?.textContent).toBe("Git confignot read")
    const { sheet } = await openSheet()
    expect(within(sheet).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
    expect(within(sheet).getByText("This list is not complete")).toBeTruthy()
    expect(within(sheet).getByText("The repository's Git config could not be read: git config failed. Trust is not offered until it can be read.")).toBeTruthy()
    expect(onTrust).not.toHaveBeenCalled()
  })

  // A command redaction hid part of cannot be reviewed, so neither trust nor
  // the acknowledgement is offered for its block (ruling Q323).
  it("offers no trust and sends nothing while a filter command is hidden", async () => {
    const onTrust = vi.fn<Trust>()
    show(withGitFilters(inventory(), {
      ...sopsFilters,
      entries: sopsFilters.entries.map((entry) => entry.operation === "smudge" ? { ...entry, command: "[REDACTED]", commandHidden: true as const } : entry),
    }), { onTrust })
    const { sheet } = await openSheet()

    expect(within(sheet).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
    expect(within(sheet).getByText("This list is not complete")).toBeTruthy()
    expect(within(sheet).getByText("Part of 1 filter command is hidden: Domovoi hides text that could hold a secret or that it cannot show exactly, so it cannot show what that command runs. Its filters stay held back, and trust is not offered while a command is hidden.")).toBeTruthy()
    expect(onTrust).not.toHaveBeenCalled()
  })

  it("offers no trust while git filter entries are left out of the list", async () => {
    show(withGitFilters(inventory(), { ...sopsFilters, omittedEntries: 2 }), { onTrust: vi.fn() })
    const { sheet } = await openSheet()

    expect(within(sheet).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
    expect(within(sheet).getByText("2 entries are not shown. Trust is not offered until every entry can be listed.")).toBeTruthy()
    expect(within(sheet).getByText("Git filters: 2 more entries were left out of this list.")).toBeTruthy()
  })

  // The daemon runs the filters only under a grant that says the client showed
  // them, naming the block by the review digest tool.inventory gave (#688).
  it("acknowledges the git filters it showed, by the review digest it was given", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trustResult({
      outcome: "trusted",
      repository: { projectId: "project-acme", configDigest: digest, trust: { state: "trusted", ...grant } },
    }))
    show(withGitFilters(inventory(), sopsFilters), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest, gitFilters: { reviewed: true, reviewDigest } })
  })

  it("acknowledges no git filter where it showed none", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trustResult({
      outcome: "trusted",
      repository: { projectId: "project-acme", configDigest: digest, trust: { state: "trusted", ...grant } },
    }))
    show(withGitFilters(inventory(), { files: [], entries: [], omittedEntries: 0, reviewDigest }), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest })
  })

  it("says the files changed when its git filters change while it is open, and acknowledges only the ones it shows now", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trustResult({
      outcome: "trusted",
      repository: { projectId: "project-acme", configDigest: digest, trust: { state: "trusted", ...grant } },
    }))
    const { rerender } = show(withGitFilters(inventory(), sopsFilters), { onTrust })
    const { user, sheet } = await openSheet()
    expect(within(sheet).queryByText("The files changed while this was open")).toBeNull()

    const newDigest = `sha256:${"d".repeat(64)}`
    rerender(loaded(withGitFilters(inventory(), {
      ...sopsFilters,
      entries: sopsFilters.entries.map((entry) => entry.operation === "smudge" ? { ...entry, command: "sops -d --keep" } : entry),
      reviewDigest: newDigest,
    })))

    const open = screen.getByRole("dialog")
    expect(within(open).getByText("The files changed while this was open")).toBeTruthy()
    expect(within(open).getByText("smudge sops -d --keep · clean sops -e")).toBeTruthy()
    await user.click(within(open).getByRole("button", { name: "Trust for this machine" }))
    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest, gitFilters: { reviewed: true, reviewDigest: newDigest } })
  })

  it("reads the files again when the daemon refuses the git filters it showed, and says they changed", async () => {
    const onTrust = vi.fn<Trust>().mockRejectedValue(new Error("Domovoi granted no trust: the git filters this client showed are not the ones Domovoi reads now."))
    const { onRetry, rerender } = show(withGitFilters(inventory(), sopsFilters), { onTrust })
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(onRetry).toHaveBeenCalledOnce()
    rerender({ state: "loading" })
    rerender(loaded(withGitFilters(inventory(), { ...sopsFilters, reviewDigest: `sha256:${"d".repeat(64)}` })))
    const open = screen.getByRole("dialog")
    expect(within(open).getByText("The files changed while this was open")).toBeTruthy()
    expect(within(open).queryByText("Trust was not granted")).toBeNull()
    // Trusting what the files hold now is a second decision.
    expect(onTrust).toHaveBeenCalledOnce()
  })

  it("counts the filter's commands among the entries held back", async () => {
    const provider = claude({ entries: entries().map((entry) => entry.file === ".mcp.json" ? entry : { ...entry, heldBack: false }) })
    show(withGitFilters(inventory(notTrusted, [provider]), sopsFilters), { onTrust: vi.fn() })

    expect(within(heldCard()).getByText("4 of 9 entries from this repository are held back. The rest load.")).toBeTruthy()
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
