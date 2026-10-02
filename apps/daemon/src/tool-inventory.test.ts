import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { demoWorkspace, toolInventorySchema, type ToolInventory, type ToolInventoryEntry } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { readRepositoryProviderConfig, type RepositoryProviderConfigOptions } from "./repository-provider-config.js"
import { projectRootRead, repositoryEntryHeldBack } from "./repository-trust-apply.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { fitToolInventory, readToolInventory } from "./tool-inventory.js"

const { id, name, platform, arch, version } = demoWorkspace.machine
const machine = { id, name, platform, arch, version }
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

const rule = (index: number, width = 40): ToolInventoryEntry => ({
  kind: "permission-rule", rule: "allow", detail: `Bash(pnpm run task${index} ${"x".repeat(width)})`,
  file: ".claude/settings.json", startsAtSessionStart: false, heldBack: false,
})

function inventory(counts: Record<string, number>, omittedEntries = 0): ToolInventory {
  return {
    machine,
    providers: Object.entries(counts).map(([provider, count]) => ({
      provider, toolServers: "read-from-files", omittedEntries,
      files: [{ path: ".claude/settings.json", source: "local-settings", state: "read" }],
      entries: Array.from({ length: count }, (_, index) => rule(index)),
    })),
  }
}

describe("readToolInventory", () => {
  // What is reported held back comes from the same policy the trust decision
  // owns, and the root is read as a session's linked worktree reads it
  // (ruling Q145 A), so a refusal every session meets shows at the root.
  it("reads the project root as its worktrees would, marking entries by the trust policy", async () => {
    const read = vi.fn(async (_root: string, _options: RepositoryProviderConfigOptions) => ({
      configDigest: `sha256:${"a".repeat(64)}`, providers: [], trustRefusals: [], documents: {},
    }))
    await readToolInventory({ machine, project: { id: "project-acme", path: "/code/acme" }, read })
    expect(read).toHaveBeenCalledWith("/code/acme", { heldBack: repositoryEntryHeldBack, asLinkedWorktree: true })
  })

  it("lists the repository's own git filters beside its trust, and nothing when it sets none", async () => {
    const gitFilters = {
      files: [{ path: ".git/config", scope: "local" as const }],
      entries: [{ driver: "sops", operation: "smudge" as const, command: "sops --decrypt /dev/stdin", required: "unset" as const, file: ".git/config", scope: "local" as const, heldBack: true }],
      omittedEntries: 0,
      reviewDigest: `sha256:${"b".repeat(64)}`,
    }
    const configDigest = `sha256:${"a".repeat(64)}`
    const project = { id: "project-acme", path: "/code/acme" }
    const withFilters = await readToolInventory({
      machine, project, read: async () => ({ configDigest, providers: [], trustRefusals: [], documents: {}, gitFilters }),
    })
    expect(withFilters.repository?.gitFilters).toEqual(gitFilters)
    const without = await readToolInventory({
      machine, project, read: async () => ({ configDigest, providers: [], trustRefusals: [], documents: {} }),
    })
    expect(without.repository).not.toHaveProperty("gitFilters")
  })

  // P8 PR B: under a grant for the digest read now that reviewed the git
  // filters, they run, so their entries are not held back; under any other
  // trust, a grant that never showed them included, they are.
  it("reports the git filters running only under a grant for the current digest that reviewed them", async () => {
    const gitFilters = {
      files: [{ path: ".git/config", scope: "local" as const }],
      entries: [{ driver: "sops", operation: "smudge" as const, command: "sops --decrypt /dev/stdin", required: "unset" as const, file: ".git/config", scope: "local" as const, heldBack: true }],
      omittedEntries: 0,
      reviewDigest: `sha256:${"b".repeat(64)}`,
    }
    const configDigest = `sha256:${"a".repeat(64)}`
    const project = { id: "project-acme", path: "/code/acme" }
    const read = async () => ({ configDigest, providers: [], trustRefusals: [], documents: {}, gitFilters })
    const grant = {
      projectId: "project-acme", trustedDigest: configDigest, trustedAt: "2026-09-30T12:00:00.000Z", trustedBy: { client: "desktop" as const },
      gitFilterReviewDigest: gitFilters.reviewDigest,
    }
    const heldBack = (inventory: ToolInventory) => inventory.repository?.gitFilters?.entries.map((entry) => entry.heldBack)

    expect(heldBack(await readToolInventory({ machine, project, grant, read }))).toEqual([false])
    const { gitFilterReviewDigest: _, ...unreviewed } = grant
    expect(heldBack(await readToolInventory({ machine, project, grant: unreviewed, read }))).toEqual([true])
    // A grant that reviewed another block than the one read now (ruling Q265).
    expect(heldBack(await readToolInventory({ machine, project, grant: { ...grant, gitFilterReviewDigest: `sha256:${"c".repeat(64)}` }, read }))).toEqual([true])
    const incomplete = async () => ({ ...await read(), gitFilters: { ...gitFilters, omittedEntries: 1 } })
    expect(heldBack(await readToolInventory({ machine, project, grant, read: incomplete }))).toEqual([true])
    expect(heldBack(await readToolInventory({ machine, project, read }))).toEqual([true])
    expect(heldBack(await readToolInventory({ machine, project, grant: { ...grant, trustedDigest: `sha256:${"b".repeat(64)}` }, read }))).toEqual([true])
    const refused = async () => ({ ...await read(), trustRefusals: [{ provider: "codex", reason: "nested-config" as const, path: "sub/.codex/config.toml" }] })
    expect(heldBack(await readToolInventory({ machine, project, grant, read: refused }))).toEqual([true])
  })

  // Slice P6b: a trusted Claude Code entry is reported as loading exactly
  // when the adapter passes it, from the documents the digest was read from.
  it("marks a trusted repository's entries by what loads, and keeps the documents out of the answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-tool-inventory-trust-"))
    try {
      await mkdir(join(root, ".claude"), { recursive: true })
      await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./bootstrap.sh" }] }] },
        permissions: { allow: ["Bash(*)"] },
        env: { PLANTED_VALUE: "planted-secret" },
      }))
      const read = vi.fn(readRepositoryProviderConfig)
      const project = { id: "project-acme", path: root }
      const untrusted = await readToolInventory({ machine, project, read })
      const grant = { projectId: "project-acme", trustedDigest: untrusted.repository!.configDigest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" as const } }
      const trusted = await readToolInventory({ machine, project, grant, read })

      expect(read).toHaveBeenLastCalledWith(root, { heldBack: repositoryEntryHeldBack, asLinkedWorktree: true, documents: true })
      expect(trusted.repository?.trust.state).toBe("trusted")
      const marks = (inventory: ToolInventory) => inventory.providers.find(({ provider }) => provider === "claude-code")!.entries.map((entry) => [entry.kind, entry.heldBack])
      expect(marks(untrusted)).toEqual([["hook", true], ["env-key", true], ["permission-rule", true]])
      expect(marks(trusted)).toEqual([["hook", false], ["env-key", false], ["permission-rule", true]])
      expect(JSON.stringify(trusted)).not.toContain("planted-secret")

      // A grant for another digest reports the held-back marks.
      const changed = await readToolInventory({ machine, project, grant: { ...grant, trustedDigest: `sha256:${"b".repeat(64)}` }, read })
      expect(changed.repository?.trust.state).toBe("untrusted")
      expect(marks(changed)).toEqual(marks(untrusted))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Slice P6c: what is reported as loading under trust is what the Codex
  // adapter passes from the same documents (codex-repository-trust.ts).
  describe("for a trusted repository's Codex configuration", () => {
    const toml = [
      'approval_policy = "never"',
      "[mcp_servers.db]",
      'command = "db-mcp"',
      'default_tools_approval_mode = "approve"',
      "[mcp_servers.remote]",
      'url = "https://mcp.example.com"',
      'bearer_token_env_var = "GITHUB_TOKEN"',
      "[mcp_servers.notes]",
      'command = "notes-mcp"',
      "",
    ].join("\n")
    const scratch: string[] = []
    afterEach(async () => removeScratchDirectories(scratch.splice(0)))

    async function root(): Promise<string> {
      const path = await mkdtemp(join(tmpdir(), "domovoi-inventory-codex-"))
      scratch.push(path)
      await mkdir(join(path, ".git"))
      await writeFile(join(path, ".git", "HEAD"), "ref: refs/heads/main\n")
      await mkdir(join(path, ".codex"))
      await writeFile(join(path, ".codex", "config.toml"), toml)
      return path
    }
    const codexEntries = (value: ToolInventory) => value.providers.find(({ provider }) => provider === "codex")!.entries
      .map((entry) => [entry.kind === "tool-server" ? entry.name : entry.kind === "permission-rule" ? entry.rule : entry.kind, entry.heldBack])
    const grantFor = (trustedDigest: string) => ({
      projectId: "project-acme", trustedDigest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" as const },
    })

    it("reports the servers Codex is given as loading and every other entry held back", async () => {
      const path = await root()
      const grant = grantFor((await readRepositoryProviderConfig(path, projectRootRead)).configDigest)
      const value = await readToolInventory({ machine, project: { id: "project-acme", path }, grant })
      expect(value.repository?.trust.state).toBe("trusted")
      expect(codexEntries(value)).toEqual([
        ["db", false], ["default_tools_approval_mode", true], ["remote", true], ["notes", true], ["approval_policy", true],
      ])
    })

    it("reports every entry held back without a grant for this configuration", async () => {
      const path = await root()
      for (const grant of [undefined, grantFor(`sha256:${"d".repeat(64)}`)]) {
        const value = await readToolInventory({ machine, project: { id: "project-acme", path }, grant })
        expect(codexEntries(value).every(([, heldBack]) => heldBack), JSON.stringify(grant)).toBe(true)
      }
    })
  })
})

const listed = (value: ToolInventory) => value.providers.map((provider) => provider.entries.length)
const omitted = (value: ToolInventory) => value.providers.map((provider) => provider.omittedEntries)

describe("fitToolInventory", () => {
  it("leaves an inventory within the budget as it is", () => {
    const whole = inventory({ "claude-code": 10 })
    expect(toolInventorySchema.safeParse(whole).success).toBe(true)
    expect(fitToolInventory(whole, bytesOf(whole))).toEqual(whole)
  })

  it("leaves out only as many entries as the budget needs, counting each", () => {
    const whole = inventory({ "claude-code": 10 })
    const fitted = fitToolInventory(whole, bytesOf(whole) - 1)
    expect(listed(fitted)).toEqual([9])
    expect(omitted(fitted)).toEqual([1])
    expect(fitted.providers[0]!.entries).toEqual(whole.providers[0]!.entries.slice(0, 9))
  })

  it("counts the digit a growing count adds", () => {
    // The count goes from 9 to 10: one byte more. A budget one byte short of
    // the inventory without its last entry is met only by leaving out two.
    const whole = inventory({ "claude-code": 10 }, 9)
    const withoutLast = { ...whole, providers: [{ ...whole.providers[0]!, omittedEntries: 10, entries: whole.providers[0]!.entries.slice(0, 9) }] }
    expect(listed(fitToolInventory(whole, bytesOf(withoutLast)))).toEqual([9])
    expect(listed(fitToolInventory(whole, bytesOf(withoutLast) - 1))).toEqual([8])
  })

  it("takes entries from the provider listing the most, so a small one keeps its list", () => {
    const whole = inventory({ "claude-code": 40, codex: 3 })
    const fitted = fitToolInventory(whole, bytesOf(whole) - 1_000)
    expect(bytesOf(fitted)).toBeLessThanOrEqual(bytesOf(whole) - 1_000)
    expect(listed(fitted)[1]).toBe(3)
    expect(listed(fitted)[0]).toBeLessThan(40)
    expect(listed(fitted)[0]! + omitted(fitted)[0]!).toBe(40)
  })
})
