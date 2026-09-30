import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { ToolInventoryEntry } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { claudeRepositoryLoad } from "./claude-repository-trust.js"
import { readRepositoryProviderConfig, type RepositoryProviderConfig } from "./repository-provider-config.js"
import {
  heldBackUnder,
  projectRootRead,
  repositoryEntryHeldBack,
  repositoryTrustVerdict,
  trustedEntryHeldBack,
  trustedRepositoryConfig,
} from "./repository-trust-apply.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"
import { removeScratchDirectories } from "./test-scratch.js"

// Slice P6a: one place decides, per session worktree, whether a repository's
// configuration is trusted. Nothing loads under the answer yet.

const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratchDirectories.push(path)
  return path
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

// A main checkout and a linked worktree of it, laid out as git lays them out,
// each holding the same repository configuration.
async function checkouts(files: Record<string, string>): Promise<{ main: string; worktree: string }> {
  const main = await scratch("domovoi-trust-main-")
  const worktree = await scratch("domovoi-trust-worktree-")
  await put(main, ".git/HEAD", "ref: refs/heads/main\n")
  await put(main, ".git/worktrees/session/HEAD", "ref: refs/heads/session\n")
  await put(main, ".git/worktrees/session/gitdir", `${join(worktree, ".git")}\n`)
  await put(main, ".git/worktrees/session/commondir", "../..\n")
  await put(worktree, ".git", `gitdir: ${join(main, ".git", "worktrees", "session")}\n`)
  for (const [path, content] of Object.entries(files)) {
    await put(main, path, content)
    await put(worktree, path, content)
  }
  return { main, worktree }
}

const settings = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./bootstrap.sh" }] }] } }
const servers = { mcpServers: { db: { command: "db-mcp" } } }
const configured = {
  ".claude/settings.json": JSON.stringify(settings),
  ".mcp.json": JSON.stringify(servers),
  ".codex/config.toml": "sandbox_mode = \"read-only\"\n",
}

const grantFor = (trustedDigest: string): RepositoryTrustGrant => ({
  projectId: "project-acme", trustedDigest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" },
})

// The grant the person gives in the trust step, which reads the project root.
async function rootGrant(main: string): Promise<RepositoryTrustGrant> {
  return grantFor((await readRepositoryProviderConfig(main, projectRootRead)).configDigest)
}

describe("repositoryTrustVerdict", () => {
  it("gives a session worktree's documents when its configuration is the one trusted at the root", async () => {
    const { main, worktree } = await checkouts(configured)
    const verdict = await repositoryTrustVerdict(worktree, await rootGrant(main))
    expect(verdict).toEqual({
      state: "trusted",
      configDigest: (await rootGrant(main)).trustedDigest,
      documents: {
        ".claude/settings.json": settings,
        ".mcp.json": servers,
        ".codex/config.toml": { sandbox_mode: "read-only" },
      },
    })
    expect(await trustedRepositoryConfig(worktree, await rootGrant(main))).toEqual(verdict.state === "trusted" ? verdict.documents : undefined)
  })

  it("holds a repository with no grant back without reading it", async () => {
    const read = vi.fn(readRepositoryProviderConfig)
    expect(await repositoryTrustVerdict("/nowhere", undefined, read)).toEqual({ state: "held-back", reason: "not-trusted" })
    expect(await trustedRepositoryConfig("/nowhere", undefined, read)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  // Ruling Q144 A: the session opens held back, with a reason later slices show.
  it("holds a worktree back when its configuration is not the one trusted", async () => {
    const { main, worktree } = await checkouts(configured)
    const grant = await rootGrant(main)
    await put(worktree, ".mcp.json", JSON.stringify({ mcpServers: { planted: { command: "planted-server" } } }))
    expect(await repositoryTrustVerdict(worktree, grant)).toEqual({ state: "held-back", reason: "config-changed" })
    expect(await trustedRepositoryConfig(worktree, grant)).toBeUndefined()
  })

  it("reads the session worktree, not the project root", async () => {
    const { main, worktree } = await checkouts(configured)
    const grant = await rootGrant(main)
    const read = vi.fn(readRepositoryProviderConfig)
    await repositoryTrustVerdict(worktree, grant, read)
    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0]![0]).toBe(worktree)
    // The root changing after the grant does not hold back a worktree that
    // still holds the trusted configuration.
    await put(main, ".mcp.json", JSON.stringify({ mcpServers: {} }))
    expect(await repositoryTrustVerdict(worktree, grant)).toMatchObject({ state: "trusted" })
  })

  it("holds a worktree back while its repository cannot be trusted, even under a grant for its digest", async () => {
    const { main, worktree } = await checkouts(configured)
    await put(main, ".codex/hooks.json", "{}")
    const hooked = await readRepositoryProviderConfig(worktree, { heldBack: false })
    expect(hooked.trustRefusals).toEqual([expect.objectContaining({ reason: "main-checkout-hooks" })])
    expect(await repositoryTrustVerdict(worktree, grantFor(hooked.configDigest))).toEqual({ state: "held-back", reason: "cannot-trust" })
    expect(await trustedRepositoryConfig(worktree, grantFor(hooked.configDigest))).toBeUndefined()
  })

  it("holds a worktree back when its configuration cannot be read, naming no path or value", async () => {
    const read = vi.fn(async (): Promise<RepositoryProviderConfig> => {
      throw new Error("The codex repository inventory does not fit the protocol")
    })
    const verdict = await repositoryTrustVerdict("/worktrees/session", grantFor(`sha256:${"a".repeat(64)}`), read)
    expect(verdict).toEqual({ state: "held-back", reason: "unreadable" })
  })
})

describe("repositoryEntryHeldBack", () => {
  const entry = (file: string, kind: ToolInventoryEntry["kind"] = "hook"): ToolInventoryEntry => (kind === "skill"
    ? { kind, name: "deploy", file, startsAtSessionStart: false, heldBack: false }
    : { kind: "hook", event: "SessionStart", command: "./bootstrap.sh", file, startsAtSessionStart: true, heldBack: false })

  // Each claim is pinned by a test of the adapter: claude.test.ts and
  // codex-repository-config.test.ts.
  it("holds back what Claude Code and Codex keep from the agent today", () => {
    expect(repositoryEntryHeldBack("claude-code", entry(".claude/settings.json"))).toBe(true)
    expect(repositoryEntryHeldBack("claude-code", entry(".mcp.json"))).toBe(true)
    expect(repositoryEntryHeldBack("codex", entry(".codex/config.toml"))).toBe(true)
    expect(repositoryEntryHeldBack("codex", entry(".codex/hooks.json"))).toBe(true)
  })

  // Domovoi's own skill catalog reads these folders and can put a skill in a
  // prompt, so no adapter provably keeps them back (ruling Q128).
  it("claims nothing for skills", () => {
    for (const [provider, file] of [["claude-code", ".claude/skills"], ["codex", ".codex/skills"], ["codex", ".agents/skills"]] as const) {
      expect(repositoryEntryHeldBack(provider, entry(file, "skill")), `${provider} ${file}`).toBe(false)
    }
  })

  // Slice P6c: under a trusted verdict a Codex server that passes loads, and
  // the policy reports it so from the same documents.
  it("reports a trusted repository's Codex servers that pass as loading, and nothing else", () => {
    const heldBack = trustedEntryHeldBack({ ".codex/config.toml": { mcp_servers: { db: { command: "db-mcp" }, notes: { command: "notes-mcp" } } } })
    const server = (name: string): ToolInventoryEntry => ({
      kind: "tool-server", name, transport: "stdio", command: "db-mcp", envKeys: [], file: ".codex/config.toml", startsAtSessionStart: true, heldBack: true,
    })
    expect(heldBack("codex", server("db"))).toBe(false)
    expect(heldBack("codex", server("notes"))).toBe(true)
    expect(heldBack("codex", entry(".codex/config.toml"))).toBe(true)
    expect(heldBack("codex", entry(".codex/hooks.json"))).toBe(true)
    expect(heldBack("codex", entry(".agents/skills", "skill"))).toBe(false)
    expect(heldBack("claude-code", entry(".mcp.json"))).toBe(true)
  })

  // P7 states what OpenCode, Kilo and the ACP agents keep back.
  it("claims nothing for another provider, even for a file of the same name", () => {
    for (const provider of ["opencode", "kilo", "cursor-agent", "grok"]) {
      expect(repositoryEntryHeldBack(provider, entry("opencode.json")), provider).toBe(false)
      expect(repositoryEntryHeldBack(provider, entry(".mcp.json")), provider).toBe(false)
      expect(repositoryEntryHeldBack(provider, entry(".codex/config.toml")), provider).toBe(false)
    }
    expect(repositoryEntryHeldBack("codex", entry(".mcp.json"))).toBe(false)
    expect(repositoryEntryHeldBack("claude-code", entry(".codex/config.toml"))).toBe(false)
  })
})

// Slice P6b: under a trusted verdict the inventory reports as loading exactly
// what the Claude adapter passes, from the same plan (claude-repository-trust.ts).
describe("heldBackUnder", () => {
  const trustedSettings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "./bootstrap.sh" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./allow.sh" }] }],
      PermissionRequest: [{ hooks: [{ type: "command", command: "./approve.sh" }] }],
    },
    env: { DATABASE_URL: "postgres://db", ANTHROPIC_BASE_URL: "https://proxy.example.com" },
    permissions: {
      allow: ["Bash(*)"], deny: ["Read(./.env)"], ask: ["Bash(git push:*)"], defaultMode: "acceptEdits", additionalDirectories: ["../other"],
    },
    apiKeyHelper: "./key.sh",
    statusLine: { type: "command", command: "./status.sh" },
    enabledPlugins: { "formatter@market": true },
    enableAllProjectMcpServers: true,
    enabledMcpjsonServers: ["db"],
  }
  const trustedServers = { mcpServers: {
    db: { command: "db-mcp" },
    remote: { type: "http", url: "https://mcp.example.com/${TEAM}" },
  } }

  async function trustedRead() {
    const { main } = await checkouts({
      ".claude/settings.json": JSON.stringify(trustedSettings),
      ".mcp.json": JSON.stringify(trustedServers),
      ".codex/config.toml": "sandbox_mode = \"read-only\"\n",
      ".claude/skills/deploy/SKILL.md": "---\nname: deploy\n---\nDeploy.",
    })
    return readRepositoryProviderConfig(main, { ...projectRootRead, documents: true })
  }

  const marks = (config: RepositoryProviderConfig, trust: Parameters<typeof heldBackUnder>[1]) => heldBackUnder(config, trust)
    .flatMap(({ provider, entries }) => entries.map((entry) => [provider, entry.kind, "event" in entry ? entry.event
      : "key" in entry ? entry.key : "rule" in entry ? `${entry.rule} ${entry.detail}` : entry.name, entry.heldBack]))

  it("reports a trusted Claude Code entry as loading exactly when the adapter passes it", async () => {
    const config = await trustedRead()
    expect(marks(config, { state: "trusted", trustedDigest: config.configDigest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" } })).toEqual([
      ["claude-code", "tool-server", "db", false],
      ["claude-code", "tool-server", "remote", true],
      ["claude-code", "hook", "SessionStart", false],
      ["claude-code", "hook", "PreToolUse", true],
      ["claude-code", "hook", "PermissionRequest", true],
      ["claude-code", "env-key", "DATABASE_URL", false],
      ["claude-code", "env-key", "ANTHROPIC_BASE_URL", true],
      ["claude-code", "permission-rule", "allow Bash(*)", true],
      ["claude-code", "permission-rule", "deny Read(./.env)", false],
      ["claude-code", "permission-rule", "ask Bash(git push:*)", false],
      ["claude-code", "permission-rule", "additionalDirectories ../other", true],
      ["claude-code", "permission-rule", "defaultMode acceptEdits", true],
      ["claude-code", "permission-rule", "enableAllProjectMcpServers true", true],
      ["claude-code", "permission-rule", "enabledMcpjsonServers db", true],
      ["claude-code", "helper", "apiKeyHelper", true],
      ["claude-code", "helper", "statusLine", true],
      ["claude-code", "plugin", "formatter@market", true],
      ["claude-code", "skill", "deploy", false],
      ["opencode", "skill", "deploy", false],
      ["kilo", "skill", "deploy", false],
      // Codex is given only a trusted repository's servers that pass (P6c),
      // so its other settings stay held back.
      ["codex", "permission-rule", "sandbox_mode read-only", true],
    ])
    // The plan the adapter passes is the one the marks come from.
    const load = claudeRepositoryLoad(config.documents)
    expect(Object.keys(load.mcpServers)).toEqual(["db"])
    expect(Object.keys(load.settings.hooks ?? {})).toEqual(["SessionStart"])
  })

  it("keeps the held-back marks for a repository that is not trusted", async () => {
    const config = await trustedRead()
    for (const trust of [
      { state: "untrusted", reason: "not-trusted" },
      { state: "untrusted", reason: "config-changed", trustedDigest: `sha256:${"b".repeat(64)}`, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" } },
    ] as const) {
      expect(heldBackUnder(config, trust)).toEqual(config.providers)
    }
  })
})
