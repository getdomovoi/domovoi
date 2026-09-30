import { toolInventorySchema, type ToolInventory } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { heldBackView, trustSummary } from "./held-back"

const digest = `sha256:${"a".repeat(64)}`
const home = "/Users/ada"

// The Skills design's Tools sample (J45), as the protocol tests carry it: two
// repository files whose every entry is held back, a local settings file that
// could not be read, and the person's own files, none of which a repository's
// trust touches.
function inventory(): ToolInventory {
  return toolInventorySchema.parse({
    machine: { id: "machine-studio", name: "studio", platform: "darwin", arch: "arm64", version: "0.9.4" },
    repository: { projectId: "project-acme", root: "/Users/ada/src/acme-api", configDigest: digest, trust: { state: "untrusted", reason: "not-trusted" } },
    providers: [
      {
        provider: "claude-code",
        toolServers: "read-from-files",
        omittedEntries: 0,
        files: [
          { path: ".mcp.json", source: "repository-file", state: "read" },
          { path: ".claude/settings.json", source: "project-settings", state: "read" },
          { path: ".claude/settings.local.json", source: "local-settings", state: "unreadable", reason: "EACCES · owned by root, mode 0600" },
          { path: `${home}/.claude.json`, source: "user-settings", state: "read" },
        ],
        entries: [
          { kind: "tool-server", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: ["PGHOST", "PGPASSWORD"], file: ".mcp.json", startsAtSessionStart: true, heldBack: true },
          { kind: "tool-server", name: "linear", transport: "http", host: "mcp.linear.app", envKeys: [], file: ".mcp.json", startsAtSessionStart: true, heldBack: true },
          { kind: "hook", event: "PreToolUse", matcher: "Bash", command: "./scripts/guard-prod.sh", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
          { kind: "permission-rule", rule: "allow", detail: "Bash(pnpm test:*)", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
          { kind: "env-key", key: "ACME_ENV", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
          { kind: "env-key", key: "DATABASE_URL", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
          { kind: "tool-server", name: "github", transport: "stdio", command: "gh-mcp serve", envKeys: ["GITHUB_TOKEN"], file: `${home}/.claude.json`, startsAtSessionStart: true, heldBack: false },
        ],
      },
      {
        provider: "codex",
        toolServers: "read-from-files",
        omittedEntries: 0,
        files: [
          { path: ".mcp.json", source: "repository-file", state: "read" },
          { path: ".codex/config.toml", source: "project-settings", state: "absent" },
        ],
        entries: [
          { kind: "tool-server", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: [], file: ".mcp.json", startsAtSessionStart: true, heldBack: true },
        ],
      },
    ],
  })
}

function loaded(view: ReturnType<typeof heldBackView>) {
  if (view.kind !== "repository") throw new Error(`expected a repository, got ${view.kind}`)
  return view
}

describe("heldBackView", () => {
  it("groups every held-back entry by the file that declared it, repository files only", () => {
    const view = loaded(heldBackView(inventory()))
    expect(view.name).toBe("acme-api")
    expect(view.files.map((file) => file.path)).toEqual([".mcp.json", ".claude/settings.json"])

    const mcp = view.files[0]!
    expect(mcp.source).toBe("repository file")
    // A file two agents read is one group, and each row names its agent.
    expect(mcp.providers).toEqual(["claude-code", "codex"])
    expect(mcp.rows.map((row) => [row.provider, row.kind, row.name, row.detail])).toEqual([
      ["claude-code", "Tool server", "postgres-dev", "stdio · npx -y @acme/pg-mcp · env keys PGHOST · PGPASSWORD, values not read"],
      ["claude-code", "Tool server", "linear", "http · mcp.linear.app"],
      ["codex", "Tool server", "postgres-dev", "stdio · npx -y @acme/pg-mcp"],
    ])
    expect(mcp.counts).toBe("3 tool servers")

    const settings = view.files[1]!
    expect(settings.source).toBe("project settings")
    expect(settings.rows.map((row) => [row.kind, row.name, row.detail])).toEqual([
      ["Hook", "PreToolUse · Bash", "./scripts/guard-prod.sh"],
      ["Rule", "allow", "Bash(pnpm test:*)"],
      // Keys one file declares are one row, and every key is on it.
      ["Env keys", "ACME_ENV · DATABASE_URL", "key names only"],
    ])
    // Two keys on one row are two entries in the count, as the daemon lists them.
    expect(settings.counts).toBe("1 hook · 2 env entries · 1 rule")

    // The person's own files are not the repository's, so they are not here,
    // and neither is a local file that could not be read.
    expect(view.files.flatMap((file) => file.rows).some((row) => row.name === "github")).toBe(false)
    expect(view.unread).toEqual([])
  })

  it("says why every entry is held back and that none of it loads", () => {
    const view = loaded(heldBackView(inventory()))
    // Counted as the daemon lists them: two env keys are two entries on one row.
    expect(view.held).toBe(7)
    expect(view.heading).toBe("acme-api is held back on studio")
    expect(view.lead).toBe("None of it loads for any agent.")
    expect(view.reason).toBe("Held back until you trust this repository.")
    expect(view.trust).toBe("not trusted")
    expect(view.awaitsTrust).toBe(true)
    expect(view.incomplete).toBeUndefined()
  })

  // Instruction files are not entries and are never held back, so a summary
  // that says nothing loads keeps the exception beside it (trust.sheet copy).
  it("says instruction files load either way whenever something is held back", () => {
    expect(loaded(heldBackView(inventory())).instructionFiles).toBe("CLAUDE.md · AGENTS.md")
    const trusted = inventory()
    for (const provider of trusted.providers) provider.entries = provider.entries.map((entry) => ({ ...entry, heldBack: false }))
    expect(loaded(heldBackView(trusted)).instructionFiles).toBeUndefined()
  })

  it("counts what is held back when only some of it is", () => {
    const partly = inventory()
    const entry = partly.providers[0]!.entries[1]!
    partly.providers[0]!.entries[1] = { ...entry, heldBack: false }
    const view = loaded(heldBackView(partly))
    expect(view.held).toBe(6)
    expect(view.lead).toBe("6 of 7 entries it brings are held back.")
    expect(view.files[0]!.rows.map((row) => row.name)).toEqual(["postgres-dev", "postgres-dev"])
  })

  it("says so when nothing is held back", () => {
    const trusted = inventory()
    trusted.repository!.trust = { state: "trusted", trustedDigest: digest, trustedAt: "2026-09-12T10:41:00Z", trustedBy: { client: "desktop" } }
    for (const provider of trusted.providers) {
      provider.entries = provider.entries.map((entry) => ({ ...entry, heldBack: false }))
    }
    const view = loaded(heldBackView(trusted))
    expect(view.held).toBe(0)
    expect(view.files).toEqual([])
    expect(view.heading).toBe("acme-api on studio")
    expect(view.lead).toBe("Nothing from this repository is held back.")
    expect(view.awaitsTrust).toBe(false)
  })

  it("says so when the repository brings nothing", () => {
    const bare = inventory()
    for (const provider of bare.providers) {
      provider.entries = provider.entries.filter((entry) => entry.file.startsWith("/"))
    }
    expect(loaded(heldBackView(bare)).lead).toBe("Its agent files declare nothing.")
  })

  it("names an unreadable repository file with its reason, and entries left out, so the list never reads as whole", () => {
    const cut = inventory()
    cut.providers[1]!.files.push({ path: ".codex/rules/default.rules", source: "project-settings", state: "unreadable", reason: "EACCES" })
    cut.providers[0]!.omittedEntries = 3
    const view = loaded(heldBackView(cut))
    expect(view.unread).toEqual([{ provider: "codex", path: ".codex/rules/default.rules", source: "project settings", reason: "EACCES" }])
    expect(view.incomplete).toBe("1 file could not be read and 3 entries were left out")
    expect(view.lead).toBe("None of what is listed loads for any agent.")
  })

  // An entry left out or a file not read may be held back, so a list that is
  // not whole speaks of what is listed and never of the whole repository.
  it("speaks of the listed entries when the list is not whole", () => {
    const partly = inventory()
    partly.providers[0]!.entries[1] = { ...partly.providers[0]!.entries[1]!, heldBack: false }
    partly.providers[0]!.omittedEntries = 2
    expect(loaded(heldBackView(partly)).lead).toBe("6 of the 7 listed entries are held back.")

    const none = inventory()
    for (const provider of none.providers) provider.entries = provider.entries.map((entry) => ({ ...entry, heldBack: false }))
    none.providers[1]!.omittedEntries = 1
    const noneView = loaded(heldBackView(none))
    expect(noneView.lead).toBe("None of the listed entries is held back.")
    expect(noneView.heading).toBe("acme-api on studio")

    const bare = inventory()
    for (const provider of bare.providers) provider.entries = provider.entries.filter((entry) => entry.file.startsWith("/"))
    bare.providers[1]!.files.push({ path: ".codex/rules/default.rules", source: "project-settings", state: "unreadable", reason: "EACCES" })
    expect(loaded(heldBackView(bare)).lead).toBe("No entry is listed from its agent files.")
  })

  it("lists why a repository cannot be trusted, and does not offer trust elsewhere", () => {
    const refused = inventory()
    refused.repository!.trust = {
      state: "untrusted",
      reason: "cannot-trust",
      refusals: [{ provider: "codex", code: "nested-config", path: "services/api/.codex" }],
      omittedRefusals: 2,
    }
    const view = loaded(heldBackView(refused))
    expect(view.trust).toBe("cannot be trusted")
    expect(view.reason).toBe("Held back.")
    expect(view.awaitsTrust).toBe(false)
    expect(view.refusals).toEqual([
      { key: "codex:nested-config:services/api/.codex:0", provider: "codex", label: "Agent configuration below the repository root", path: "services/api/.codex" },
    ])
    expect(view.omittedRefusals).toBe(2)
  })

  it("holds back from a trusted repository without claiming trust would lift it", () => {
    const trusted = inventory()
    trusted.repository!.trust = { state: "trusted", trustedDigest: digest, trustedAt: "2026-09-12T10:41:00Z", trustedBy: { client: "web" } }
    const view = loaded(heldBackView(trusted))
    expect(view.reason).toBe("Held back, although this repository is trusted.")
    expect(view.awaitsTrust).toBe(false)
  })

  it("has nothing to hold back when no project is open", () => {
    const none = toolInventorySchema.parse({ machine: inventory().machine, providers: [] })
    expect(heldBackView(none)).toEqual({ kind: "no-project", machine: "studio" })
  })
})

describe("trustSummary", () => {
  it("words each trust state", () => {
    const at = "2026-09-12T10:41:00Z"
    const time = new Date(at)
    const pad = (value: number) => String(value).padStart(2, "0")
    const local = `${pad(time.getDate())} Sep ${pad(time.getHours())}:${pad(time.getMinutes())}`
    expect(trustSummary({ state: "untrusted", reason: "not-trusted" })).toBe("not trusted")
    expect(trustSummary({ state: "trusted", trustedDigest: digest, trustedAt: at, trustedBy: { client: "desktop" } })).toBe(`trusted ${local} from desktop`)
    expect(trustSummary({ state: "untrusted", reason: "config-changed", trustedDigest: digest, trustedAt: at, trustedBy: { client: "web" } }))
      .toBe(`trusted ${local} from web · no longer applies`)
  })
})
