import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  toolInventorySchema,
  type RepositoryTrustState,
  type ToolInventory,
  type ToolInventoryEntry,
  type ToolInventoryProvider,
} from "@getdomovoi/protocol"

import { ToolInventoryView } from "./tool-inventory-view.js"

afterEach(cleanup)

const digest = `sha256:${"a".repeat(64)}`
const earlierDigest = `sha256:${"b".repeat(64)}`
const grant = { trustedDigest: digest, trustedAt: "2026-09-12T10:41:00.000Z", trustedBy: { client: "desktop" as const } }
const readAt = new Date("2026-09-29T14:02:31")

type Flags = { heldBack?: boolean }

function claudeEntries({ heldBack = false }: Flags = {}): ToolInventoryEntry[] {
  return [
    { kind: "tool-server", file: ".mcp.json", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: ["PGHOST", "PGUSER"], startsAtSessionStart: true, heldBack },
    { kind: "tool-server", file: ".mcp.json", name: "linear", transport: "http", host: "mcp.linear.app", envKeys: [], startsAtSessionStart: true, heldBack },
    { kind: "plugin", file: ".claude/settings.json", name: "acme-review@acme-plugins", startsAtSessionStart: true, heldBack },
    { kind: "env-key", file: ".claude/settings.json", key: "ACME_ENV", startsAtSessionStart: true, heldBack },
    { kind: "env-key", file: ".claude/settings.json", key: "DATABASE_URL", startsAtSessionStart: true, heldBack },
    { kind: "hook", file: ".claude/settings.json", event: "SessionStart", command: "./scripts/dev-bootstrap.sh", startsAtSessionStart: true, heldBack },
    { kind: "hook", file: ".claude/settings.json", event: "PreToolUse", matcher: "Bash", command: "./scripts/guard-prod.sh", startsAtSessionStart: false, heldBack },
    { kind: "permission-rule", file: ".claude/settings.json", rule: "allow", detail: "Bash(pnpm test:*)", startsAtSessionStart: false, heldBack },
  ]
}

function claude(overrides: Partial<ToolInventoryProvider> = {}, flags: Flags = {}): ToolInventoryProvider {
  return {
    provider: "claude-code",
    toolServers: "read-from-files",
    omittedEntries: 0,
    files: [
      { path: ".mcp.json", source: "repository-file", state: "read" },
      { path: ".claude/settings.json", source: "project-settings", state: "read" },
    ],
    entries: claudeEntries(flags),
    ...overrides,
  }
}

function codexNonePassed(): ToolInventoryProvider {
  return {
    provider: "codex",
    toolServers: "none-passed",
    omittedEntries: 0,
    files: [
      { path: ".codex/config.toml", source: "project-settings", state: "absent" },
      { path: ".codex/hooks.json", source: "project-settings", state: "absent" },
    ],
    entries: [],
  }
}

function inventory(providers: ToolInventoryProvider[], trust: RepositoryTrustState = { state: "trusted", ...grant }): ToolInventory {
  // Every fixture is a message the daemon could send.
  return toolInventorySchema.parse({
    machine: { id: "machine-1", name: "mac-mini-m4", platform: "darwin", arch: "arm64", version: "0.9.4" },
    repository: {
      projectId: "project-acme",
      root: "~/src/acme-api",
      configDigest: trust.state === "untrusted" && trust.reason === "config-changed" ? earlierDigest : digest,
      trust,
    },
    providers,
  })
}

function show(value: ToolInventory, onRetry = vi.fn()) {
  render(<ToolInventoryView inventory={{ state: "loaded", inventory: value, readAt }} onRetry={onRetry} />)
}

function panel(name: string): HTMLElement {
  return screen.getByRole("region", { name })
}

describe("tools by agent", () => {
  it("names the machine and the repository, and says it only reads", () => {
    show(inventory([claude(), codexNonePassed()]))

    expect(screen.getByRole("heading", { level: 1, name: "Tools on mac-mini-m4" })).toBeTruthy()
    expect(screen.getByText("acme-api · ~/src/acme-api")).toBeTruthy()
    expect(screen.getByText("Domovoi reads these files and reports what they declare. It installs, enables and changes nothing.")).toBeTruthy()
    expect(screen.getByText("Read only")).toBeTruthy()
    expect(screen.getByText("read 14:02:31 · 2 files")).toBeTruthy()
  })

  it("leads with the repository entries that run when a session starts, trusted", () => {
    show(inventory([claude(), codexNonePassed()]))

    const runs = screen.getByRole("region", { name: "5 entries from this repository run when a session starts" })
    expect(within(runs).getByText(/^acme-api · trusted \d{2} Sep \d{2}:\d{2} from desktop$/)).toBeTruthy()
    expect(within(runs).getByText("postgres-dev")).toBeTruthy()
    expect(within(runs).getByText("linear")).toBeTruthy()
    expect(within(runs).getByText("SessionStart")).toBeTruthy()
    expect(within(runs).getByText("ACME_ENV · DATABASE_URL")).toBeTruthy()
    expect(within(runs).getByText("acme-review@acme-plugins")).toBeTruthy()
    expect(within(runs).queryByText("PreToolUse · Bash")).toBeNull()
    expect(within(runs).getByText("Listed before any session opens. Reading them does not start them.")).toBeTruthy()
    // Trust is granted and taken back in a later step; this tab only reads.
    expect(screen.queryByText("Take back trust")).toBeNull()
  })

  it("marks each entry that runs at session start from its own heldBack, not from trust", () => {
    show(inventory([claude(), codexNonePassed()]))

    const agent = panel("claude-code")
    expect(within(agent).getByText("FROM THIS REPOSITORY")).toBeTruthy()
    expect(within(agent).getByText("Project settings and repository files. Trusted here, so they run when a session starts.")).toBeTruthy()
    expect(within(agent).getAllByText("Runs when a session starts")).toHaveLength(5)
    const guard = within(agent).getByText("PreToolUse · Bash").closest("li")!
    expect(within(guard).queryByText("Runs when a session starts")).toBeNull()
    expect(within(agent).getByText("stdio · npx -y @acme/pg-mcp · env keys PGHOST · PGUSER, values not read")).toBeTruthy()
    expect(within(agent).getByText("http · mcp.linear.app")).toBeTruthy()
    expect(within(agent).getByText("key names only")).toBeTruthy()
    expect(within(agent).getAllByText("repository file")).toHaveLength(2)
    expect(within(agent).getByText("2 files read · 7 entries")).toBeTruthy()
  })

  it("says user and local settings were not read when no such file is listed", () => {
    show(inventory([claude()]))

    const agent = panel("claude-code")
    expect(within(agent).getByText("THIS MACHINE ONLY")).toBeTruthy()
    expect(within(agent).getByText("User and local settings were not read.")).toBeTruthy()
    expect(within(agent).queryByText("Nothing found.")).toBeNull()
  })

  it("lists user and local settings entries under this machine only", () => {
    const provider = claude({
      files: [...claude().files, { path: "~/.claude/settings.json", source: "user-settings", state: "read" }],
      entries: [...claudeEntries(), { kind: "hook", file: "~/.claude/settings.json", event: "Stop", command: "afplay /System/Library/Sounds/Glass.aiff", startsAtSessionStart: false, heldBack: false }],
    })
    show(inventory([provider]))

    const agent = panel("claude-code")
    expect(within(agent).getByText("User and local settings, not committed.")).toBeTruthy()
    expect(within(agent).getByText("Stop")).toBeTruthy()
    expect(within(agent).getByText("user settings")).toBeTruthy()
  })

  it("says an agent starts with no tool servers passed", () => {
    show(inventory([claude(), codexNonePassed()]))

    const agent = panel("codex")
    expect(within(agent).getByText("Tool servers")).toBeTruthy()
    expect(within(agent).getByText("none passed")).toBeTruthy()
    expect(within(agent).getByText("This agent starts with no tool servers passed.")).toBeTruthy()
    // Nothing found is a result, so the panel lists every file it looked for.
    expect(within(agent).getByText("No tool servers, hooks or permission rules in the files read.")).toBeTruthy()
    expect(within(agent).getByText(".codex/config.toml")).toBeTruthy()
    expect(within(agent).getByText(".codex/hooks.json")).toBeTruthy()
    expect(within(agent).getAllByText("not present")).toHaveLength(2)
  })

  it("lists every file it read when nothing is found", () => {
    const empty: ToolInventoryProvider = {
      provider: "claude-code",
      toolServers: "read-from-files",
      omittedEntries: 0,
      files: [
        { path: ".mcp.json", source: "repository-file", state: "absent" },
        { path: ".claude/settings.json", source: "project-settings", state: "empty" },
      ],
      entries: [],
    }
    show(inventory([empty], { state: "untrusted", reason: "not-trusted" }))

    const agent = panel("claude-code")
    expect(within(agent).getByText("No tool servers, hooks or permission rules in the files read.")).toBeTruthy()
    expect(within(agent).getByText("not present")).toBeTruthy()
    expect(within(agent).getByText("read, nothing declared")).toBeTruthy()
    // Nothing found covers the files read, and no user file was read.
    expect(within(agent).getByText("User and local settings were not read.")).toBeTruthy()
    expect(screen.getByText("Nothing from this repository can run when a session starts.")).toBeTruthy()
    expect(screen.getByText("acme-api · not trusted")).toBeTruthy()
  })

  it("names a file it could not read and does not claim nothing runs", () => {
    const provider = claude({
      files: [
        { path: ".mcp.json", source: "repository-file", state: "absent" },
        { path: ".claude/settings.json", source: "project-settings", state: "unreadable", reason: "io-error" },
      ],
      entries: [],
    })
    show(inventory([provider], { state: "untrusted", reason: "not-trusted" }))

    const agent = panel("claude-code")
    expect(within(agent).getByText("Could not read")).toBeTruthy()
    expect(within(agent).getByText("io-error")).toBeTruthy()
    expect(within(agent).getByText("Its entries are not listed. Domovoi does not guess what the file holds.")).toBeTruthy()
    expect(within(agent).queryByText("No tool servers, hooks or permission rules in the files read.")).toBeNull()
    expect(screen.getByText("read 14:02:31 · 0 files · 1 unreadable")).toBeTruthy()
    expect(screen.queryByText("Nothing from this repository can run when a session starts.")).toBeNull()
    expect(screen.getByText("No entry listed here runs when a session starts, but the list is not complete: 1 file could not be read.")).toBeTruthy()
  })

  it("says the running entries may not be all of them when a file could not be read", () => {
    const provider = claude({
      files: [
        { path: ".mcp.json", source: "repository-file", state: "read" },
        { path: ".claude/settings.json", source: "project-settings", state: "unreadable", reason: "invalid-json" },
      ],
      entries: claudeEntries().filter((entry) => entry.file === ".mcp.json"),
    })
    show(inventory([provider]))

    const runs = screen.getByRole("region", { name: "2 entries from this repository run when a session starts" })
    expect(within(runs).getByText("This list is not complete: 1 file could not be read.")).toBeTruthy()
  })

  it("counts entries the daemon left out, and does not claim the list is whole", () => {
    const provider = claude({ omittedEntries: 3, entries: claudeEntries().filter((entry) => entry.startsAtSessionStart === false) })
    show(inventory([provider]))

    const agent = panel("claude-code")
    expect(within(agent).getByText("2 files read · 2 entries · 3 left out")).toBeTruthy()
    expect(within(agent).getByText("3 more entries were left out to keep the answer within its size limit. They are not listed here.")).toBeTruthy()
    expect(screen.queryByText("Nothing from this repository can run when a session starts.")).toBeNull()
    expect(screen.getByText("No entry listed here runs when a session starts, but the list is not complete: 3 entries were left out.")).toBeTruthy()
  })
})

describe("trust states", () => {
  it("says what is held back from each entry's heldBack", () => {
    show(inventory([claude({}, { heldBack: true }), codexNonePassed()], { state: "untrusted", reason: "not-trusted" }))

    const agent = panel("claude-code")
    expect(within(agent).getAllByText("Held back until you trust this repository")).toHaveLength(7)
    expect(within(agent).queryByText("Runs when a session starts")).toBeNull()
    expect(within(agent).getByText("Project settings and repository files. Held back until you trust this repository.")).toBeTruthy()
    expect(screen.getByText("Nothing from this repository can run when a session starts.")).toBeTruthy()
    expect(screen.getByText("acme-api · not trusted")).toBeTruthy()
  })

  it("does not call an untrusted repository's entries held back when the daemon does not hold them back", () => {
    show(inventory([claude(), codexNonePassed()], { state: "untrusted", reason: "not-trusted" }))

    const runs = screen.getByRole("region", { name: "5 entries from this repository run when a session starts" })
    expect(within(runs).getByText("acme-api · not trusted")).toBeTruthy()
    const agent = panel("claude-code")
    expect(within(agent).getByText("Project settings and repository files. Not held back, so they run when a session starts.")).toBeTruthy()
    expect(within(agent).queryByText("Held back until you trust this repository")).toBeNull()
    expect(screen.queryByText(/Trusted here/)).toBeNull()
  })

  it("counts held and not held entries when only some are held back", () => {
    const entries = claudeEntries().map((entry) => entry.file === ".mcp.json" ? { ...entry, heldBack: true } : entry)
    show(inventory([claude({ entries })], { state: "untrusted", reason: "not-trusted" }))

    expect(within(panel("claude-code")).getByText("Project settings and repository files. 2 of 7 held back until you trust this repository.")).toBeTruthy()
    expect(screen.getByRole("region", { name: "3 entries from this repository run when a session starts" })).toBeTruthy()
  })

  it("shows an earlier grant that no longer applies", () => {
    show(inventory([claude({}, { heldBack: true })], { state: "untrusted", reason: "config-changed", ...grant }))

    expect(screen.getByText(/^acme-api · trusted \d{2} Sep \d{2}:\d{2} from desktop · no longer applies$/)).toBeTruthy()
    expect(screen.queryByText(/Trusted here/)).toBeNull()
  })

  it("lists why a repository cannot be trusted, and how many reasons are not listed", () => {
    show(inventory([claude()], {
      state: "untrusted",
      reason: "cannot-trust",
      refusals: [
        { provider: "codex", code: "nested-config", path: "packages/api/.codex" },
        { provider: "codex", code: "instructions-outside", path: "/etc/codex/instructions.md" },
      ],
      omittedRefusals: 2,
    }))

    const refusals = screen.getByRole("region", { name: "acme-api cannot be trusted on this machine" })
    expect(within(refusals).getByText("Agent configuration below the repository root")).toBeTruthy()
    expect(within(refusals).getByText("packages/api/.codex")).toBeTruthy()
    expect(within(refusals).getByText("An instruction file outside the repository or reached through a link")).toBeTruthy()
    expect(within(refusals).getByText("2 more reasons are not listed.")).toBeTruthy()
    expect(screen.getByText("acme-api · cannot be trusted")).toBeTruthy()
  })
})

describe("tools by source file", () => {
  it("shows one panel per file, repository files first", async () => {
    const user = userEvent.setup()
    const provider = claude({
      files: [
        { path: "~/.claude/settings.json", source: "user-settings", state: "read" },
        ...claude().files,
        { path: ".claude/settings.local.json", source: "local-settings", state: "unreadable", reason: "too-large" },
      ],
      entries: [...claudeEntries(), { kind: "permission-rule", file: "~/.claude/settings.json", rule: "allow", detail: "WebFetch(domain:docs.stripe.com)", startsAtSessionStart: false, heldBack: false }],
    })
    show(inventory([provider, codexNonePassed()]))

    await user.click(screen.getByRole("radio", { name: "By source file" }))

    const files = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))
    expect(files.slice(1)).toEqual([".mcp.json", ".claude/settings.json", "~/.claude/settings.json", ".claude/settings.local.json"])
    expect(screen.getByText("FROM THIS REPOSITORY")).toBeTruthy()
    expect(screen.getByText("These can run when a session starts.")).toBeTruthy()
    expect(screen.getByText("THIS MACHINE ONLY")).toBeTruthy()

    const mcp = panel(".mcp.json")
    expect(within(mcp).getByText("repository file")).toBeTruthy()
    expect(within(mcp).getByText("claude-code")).toBeTruthy()
    expect(within(mcp).getByText("2 entries")).toBeTruthy()
    expect(within(mcp).getByText("DECLARES")).toBeTruthy()
    expect(within(mcp).getByText("2 tool servers")).toBeTruthy()

    const settings = panel(".claude/settings.json")
    expect(within(settings).getByText("5 entries")).toBeTruthy()
    expect(within(settings).getByText("2 hooks · 1 plugin · 1 env entry · 1 rule")).toBeTruthy()

    const unread = panel(".claude/settings.local.json")
    expect(within(unread).getByText("not read")).toBeTruthy()
    expect(within(unread).getByText("UNREAD")).toBeTruthy()
    expect(within(unread).getByText("too-large")).toBeTruthy()

    const foot = screen.getByRole("note", { name: "codex" })
    expect(within(foot).getByText("none passed")).toBeTruthy()
    expect(within(foot).getByText("This agent starts with no tool servers passed.")).toBeTruthy()
    expect(within(foot).getByText("not present: .codex/config.toml, .codex/hooks.json")).toBeTruthy()
  })

  it("says the repository's entries are held back when every one is", async () => {
    const user = userEvent.setup()
    show(inventory([claude({}, { heldBack: true })], { state: "untrusted", reason: "not-trusted" }))

    await user.click(screen.getByRole("radio", { name: "By source file" }))

    expect(screen.queryByText("These can run when a session starts.")).toBeNull()
    expect(screen.getByText("Held back until you trust this repository.")).toBeTruthy()
  })
})

describe("other states", () => {
  it("asks for a project when none is open", () => {
    const value = toolInventorySchema.parse({
      machine: { id: "machine-1", name: "mac-mini-m4", platform: "darwin", arch: "arm64", version: "0.9.4" },
      providers: [],
    })
    show(value)

    expect(screen.getByRole("heading", { level: 1, name: "Tools on mac-mini-m4" })).toBeTruthy()
    expect(screen.getByText("No project is open")).toBeTruthy()
    expect(screen.getByText("Open a project, and Domovoi reads the files its agents would load there.")).toBeTruthy()
  })

  it("says it is reading while the daemon answers", () => {
    render(<ToolInventoryView inventory={{ state: "loading" }} onRetry={vi.fn()} />)

    expect(screen.getByRole("status").textContent).toBe("Reading the agents' files on the execution machine.")
  })

  it("names a failed read and tries again on request", async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(<ToolInventoryView inventory={{ state: "error", message: "Internal error" }} onRetry={onRetry} />)

    expect(screen.getByText("Tools could not be read")).toBeTruthy()
    expect(screen.getByText("Internal error")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
