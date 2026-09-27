import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"

import { toolInventoryProviderSchema, toolInventorySchema, type ToolInventoryProvider } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { maximumRepositoryConfigFileBytes, readRepositoryProviderConfig } from "./repository-provider-config.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

async function scratch(prefix = "domovoi-provider-config-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratchDirectories.push(path)
  return path
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

function provider(result: { providers: ToolInventoryProvider[] }, id: string): ToolInventoryProvider {
  const found = result.providers.find((entry) => entry.provider === id)
  if (!found) throw new Error(`no provider ${id}`)
  return found
}

const secrets = ["s3cr3t-value", "hunter2", "prod-db-pass", "tok-abc", "q-secret", "env-secret", "opaque-header-secret", "opaque-fragment-secret"]

function expectNoSecret(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of secrets) expect(text).not.toContain(secret)
}

describe("readRepositoryProviderConfig: Claude Code", () => {
  it("lists servers, hooks, env keys, rules, helpers and plugins, redacted", async () => {
    const root = await scratch()
    await put(root, ".mcp.json", JSON.stringify({
      mcpServers: {
        local: { command: "npx", args: ["server", "--api-key", "s3cr3t-value", "DATABASE_URL=postgres://u:hunter2@db/x"], env: { API_TOKEN: "env-secret", REGION: "eu" } },
        remote: { type: "http", url: "https://user:tok-abc@mcp.example.com:8443/v1?key=q-secret", headers: { Authorization: "Bearer tok-abc" } },
      },
    }))
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "NODE_ENV=production pnpm build" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "PGPASSWORD=prod-db-pass psql -c 'select 1'" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "curl -H 'X-Custom: opaque-header-secret' https://hooks.example.com/cb#opaque-fragment-secret" }] }],
      },
      env: { DATABASE_URL: "postgres://u:hunter2@db/x", DEBUG: "1" },
      permissions: { allow: ["Bash(pnpm test:*)"], deny: ["Read(./.env)"], defaultMode: "acceptEdits" },
      apiKeyHelper: "echo sk-ant-s3cr3t-value00",
      enabledPlugins: { "formatter@market": true, "off@market": false },
    }))

    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    const claude = provider(result, "claude-code")

    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expectNoSecret(result)
    expect(claude.files).toEqual([
      { path: ".mcp.json", source: "repository-file", state: "read" },
      { path: ".claude/settings.json", source: "project-settings", state: "read" },
    ])
    expect(claude.omittedEntries).toBe(0)
    expect(claude.entries).toEqual(expect.arrayContaining([
      {
        kind: "tool-server", name: "local", transport: "stdio", file: ".mcp.json", startsAtSessionStart: true, heldBack: true,
        command: "npx server --api-key [REDACTED] DATABASE_URL=[REDACTED]", envKeys: ["API_TOKEN", "REGION"],
      },
      {
        kind: "tool-server", name: "remote", transport: "http", file: ".mcp.json", startsAtSessionStart: true, heldBack: true,
        host: "mcp.example.com:8443", envKeys: [],
      },
      { kind: "hook", event: "SessionStart", command: "NODE_ENV=[REDACTED] pnpm build", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
      { kind: "hook", event: "PreToolUse", matcher: "Bash", command: "PGPASSWORD=[REDACTED] psql -c 'select 1'", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
      {
        kind: "hook", event: "PostToolUse", command: "curl -H 'X-Custom: [REDACTED]' https://hooks.example.com/[REDACTED]#[REDACTED]",
        file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true,
      },
      { kind: "env-key", key: "DATABASE_URL", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
      { kind: "env-key", key: "DEBUG", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
      { kind: "permission-rule", rule: "allow", detail: "Bash(pnpm test:*)", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
      { kind: "permission-rule", rule: "deny", detail: "Read(./.env)", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
      { kind: "permission-rule", rule: "defaultMode", detail: "acceptEdits", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
      { kind: "helper", name: "apiKeyHelper", command: "echo [REDACTED]", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
      { kind: "plugin", name: "formatter@market", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
    ]))
    expect(claude.entries.some((entry) => entry.kind === "plugin" && entry.name === "off@market")).toBe(false)
  })

  it("does not read the person's local settings", async () => {
    const root = await scratch()
    await put(root, ".claude/settings.local.json", JSON.stringify({ env: { LOCAL_ONLY: "1" } }))
    const before = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(provider(before, "claude-code")).toEqual({ provider: "claude-code", toolServers: "read-from-files", omittedEntries: 0, files: [], entries: [] })
    await put(root, ".claude/settings.local.json", JSON.stringify({ env: { LOCAL_ONLY: "2" } }))
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).toBe(before.configDigest)
  })

  it("names skills and keeps commands and agents in the digest", async () => {
    const root = await scratch()
    await put(root, ".claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\nDeploy.")
    await put(root, ".claude/commands/review.md", "Review")
    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    const claude = provider(result, "claude-code")
    expect(claude.files).toEqual([
      { path: ".claude/skills", source: "repository-file", state: "read" },
      { path: ".claude/commands", source: "repository-file", state: "read" },
    ])
    expect(claude.entries).toEqual([{ kind: "skill", name: "deploy", file: ".claude/skills", startsAtSessionStart: false, heldBack: true }])
    await put(root, ".claude/commands/review.md", "Review harder")
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).not.toBe(result.configDigest)
  })
})

describe("readRepositoryProviderConfig: OpenCode and Kilo", () => {
  it("reads JSONC config, plugins and plugin files without running them", async () => {
    const root = await scratch()
    const ran = join(root, "plugin-ran")
    await put(root, "opencode.jsonc", `{
      // comment with "quotes" and a url https://x
      "mcp": {
        "db": { "type": "local", "command": ["db-mcp", "--password", "hunter2"], "environment": { "PGPASSWORD": "prod-db-pass" } },
        "docs": { "type": "remote", "url": "https://docs.example.com/mcp?token=q-secret", "enabled": false },
      },
      "plugin": ["opencode-helper@1.0.0"],
      "permission": { "bash": { "git push *": "ask" }, "edit": "allow" },
      "formatter": { "fmt": { "command": ["fmt", "--token", "tok-abc"] } },
    }`)
    await put(root, ".opencode/plugin/side-effect.ts", `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(ran)}, "ran")\n`)
    await put(root, ".opencode/package.json", "{}")

    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    const opencode = provider(result, "opencode")
    expect(toolInventoryProviderSchema.safeParse(opencode).success).toBe(true)
    expectNoSecret(result)
    await expect(import("node:fs/promises").then(({ access }) => access(ran))).rejects.toThrow()
    expect(opencode.files).toEqual([
      { path: "opencode.jsonc", source: "project-settings", state: "read" },
      { path: ".opencode/package.json", source: "repository-file", state: "read" },
      { path: ".opencode/plugin", source: "repository-file", state: "read" },
    ])
    expect(opencode.entries).toEqual(expect.arrayContaining([
      { kind: "tool-server", name: "db", transport: "stdio", command: "db-mcp --password [REDACTED]", envKeys: ["PGPASSWORD"], file: "opencode.jsonc", startsAtSessionStart: true, heldBack: true },
      { kind: "tool-server", name: "docs", transport: "http", host: "docs.example.com", envKeys: [], file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
      { kind: "plugin", name: "opencode-helper@1.0.0", file: "opencode.jsonc", startsAtSessionStart: true, heldBack: true },
      { kind: "permission-rule", rule: "ask", detail: "bash git push *", file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
      { kind: "permission-rule", rule: "allow", detail: "edit", file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
      { kind: "helper", name: "formatter fmt", command: "fmt --token [REDACTED]", file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
      { kind: "plugin", name: "side-effect.ts", file: ".opencode/plugin", startsAtSessionStart: true, heldBack: true },
    ]))
    // Kilo reads opencode.jsonc too, but not .opencode/.
    const kilo = provider(result, "kilo")
    expect(kilo.files).toEqual([{ path: "opencode.jsonc", source: "project-settings", state: "read" }])
  })

  it("reads Kilo's legacy MCP file and custom modes", async () => {
    const root = await scratch()
    await put(root, ".kilocode/mcp.json", JSON.stringify({
      mcpServers: {
        search: { command: "search-mcp", args: [], env: { SEARCH_KEY: "env-secret" }, disabled: true, alwaysAllow: ["query"] },
        remote: { type: "streamable-http", url: "https://remote.example.com/mcp" },
      },
    }))
    await put(root, ".kilocodemodes", "customModes:\n  - slug: reviewer\n    name: Reviewer\n    groups: [read, [edit, {fileRegex: '\\.md$'}], command]\n")
    const kilo = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "kilo")
    expect(toolInventoryProviderSchema.safeParse(kilo).success).toBe(true)
    expect(kilo.entries).toEqual([
      { kind: "tool-server", name: "search", transport: "stdio", command: "search-mcp", envKeys: ["SEARCH_KEY"], file: ".kilocode/mcp.json", startsAtSessionStart: false, heldBack: true },
      { kind: "permission-rule", rule: "alwaysAllow", detail: "search query", file: ".kilocode/mcp.json", startsAtSessionStart: false, heldBack: true },
      { kind: "tool-server", name: "remote", transport: "http", host: "remote.example.com", envKeys: [], file: ".kilocode/mcp.json", startsAtSessionStart: true, heldBack: true },
      { kind: "permission-rule", rule: "customModes", detail: "reviewer read edit command", file: ".kilocodemodes", startsAtSessionStart: false, heldBack: true },
    ])
  })

  // Kilo 7.8.1 loads config.json beside kilo.json at the root and in .kilo/
  // and .kilocode/, and TUI plugins from tui.json(c) there; OpenCode 1.18.32
  // loads tui.json(c) at the root and in .opencode/.
  it("reads Kilo's config.json and the TUI plugin files", async () => {
    const root = await scratch()
    const server = (name: string) => JSON.stringify({ mcp: { [name]: { type: "local", command: [`${name}-mcp`] } } })
    await put(root, "config.json", server("root"))
    await put(root, ".kilo/config.json", server("kilo"))
    await put(root, ".kilocode/config.json", server("kilocode"))
    await put(root, "tui.json", JSON.stringify({ plugin: ["root-tui@1.0.0"] }))
    // A TUI file loads plugins, not servers.
    await put(root, ".kilo/tui.jsonc", `{ "plugin": ["kilo-tui@1.0.0"], "mcp": { "ignored": { "type": "local", "command": ["x"] } } }`)
    await put(root, ".kilocode/tui.json", JSON.stringify({ plugin: [["kilocode-tui@1.0.0", {}]] }))
    await put(root, ".opencode/tui.json", JSON.stringify({ plugin: ["opencode-tui@1.0.0"] }))

    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    const kilo = provider(result, "kilo")
    expect(toolInventoryProviderSchema.safeParse(kilo).success).toBe(true)
    expect(kilo.files).toEqual([
      { path: "config.json", source: "project-settings", state: "read" },
      { path: "tui.json", source: "project-settings", state: "read" },
      { path: ".kilocode/config.json", source: "project-settings", state: "read" },
      { path: ".kilocode/tui.json", source: "project-settings", state: "read" },
      { path: ".kilo/config.json", source: "project-settings", state: "read" },
      { path: ".kilo/tui.jsonc", source: "project-settings", state: "read" },
    ])
    const tool = (name: string, file: string) => ({
      kind: "tool-server", name, transport: "stdio", command: `${name}-mcp`, envKeys: [], file, startsAtSessionStart: true, heldBack: true,
    })
    const plugin = (name: string, file: string) => ({ kind: "plugin", name, file, startsAtSessionStart: true, heldBack: true })
    expect(kilo.entries).toEqual([
      tool("root", "config.json"),
      plugin("root-tui@1.0.0", "tui.json"),
      tool("kilocode", ".kilocode/config.json"),
      plugin("kilocode-tui@1.0.0", ".kilocode/tui.json"),
      tool("kilo", ".kilo/config.json"),
      plugin("kilo-tui@1.0.0", ".kilo/tui.jsonc"),
    ])
    const opencode = provider(result, "opencode")
    expect(opencode.files).toEqual([
      { path: "tui.json", source: "project-settings", state: "read" },
      { path: ".opencode/tui.json", source: "project-settings", state: "read" },
    ])
    expect(opencode.entries).toEqual([plugin("root-tui@1.0.0", "tui.json"), plugin("opencode-tui@1.0.0", ".opencode/tui.json")])
  })
})

describe("readRepositoryProviderConfig: files it refuses", () => {
  it("never follows a link out of the repository", async () => {
    const root = await scratch()
    const outside = await scratch("domovoi-provider-outside-")
    await put(outside, "kilo/mcp.json", JSON.stringify({ mcpServers: { stolen: { command: "outside-server" } } }))
    await put(outside, "claude/settings.json", JSON.stringify({ env: { OUTSIDE_KEY: "1" } }))
    await put(outside, "plugins/outside.ts", "outside")
    // Directory links, junctions on Windows, so every platform runs this: a
    // link where a file is expected, a linked parent directory, a linked
    // member of a scoped directory, and a linked provider directory.
    const linkDirectory = (target: string, path: string) => symlink(target, path, process.platform === "win32" ? "junction" : "dir")
    await linkDirectory(join(outside, "claude"), join(root, ".mcp.json"))
    await linkDirectory(join(outside, "claude"), join(root, ".claude"))
    await mkdir(join(root, ".opencode", "plugin"), { recursive: true })
    await linkDirectory(join(outside, "plugins"), join(root, ".opencode", "plugin", "linked"))
    await linkDirectory(join(outside, "kilo"), join(root, ".kilo"))

    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(JSON.stringify(result)).not.toMatch(/outside-server|OUTSIDE_KEY|stolen|outside\.ts/u)
    expect(provider(result, "claude-code").files).toEqual([
      { path: ".mcp.json", source: "repository-file", state: "unreadable", reason: "symbolic-link" },
      { path: ".claude/settings.json", source: "project-settings", state: "unreadable", reason: "symbolic-link" },
      { path: ".claude/skills", source: "repository-file", state: "unreadable", reason: "symbolic-link" },
      { path: ".claude/commands", source: "repository-file", state: "unreadable", reason: "symbolic-link" },
      { path: ".claude/agents", source: "repository-file", state: "unreadable", reason: "symbolic-link" },
    ])
    expect(provider(result, "claude-code").entries).toEqual([])
    expect(provider(result, "opencode").files).toEqual([
      { path: ".opencode/plugin", source: "repository-file", state: "unreadable", reason: "unreadable-member" },
      { path: ".claude/skills", source: "repository-file", state: "unreadable", reason: "symbolic-link" },
    ])
    expect(provider(result, "opencode").entries).toEqual([])
    const kilo = provider(result, "kilo")
    expect(kilo.files).toContainEqual({ path: ".kilo/mcp.json", source: "repository-file", state: "unreadable", reason: "symbolic-link" })
    expect(kilo.files.every((file) => file.state === "unreadable")).toBe(true)
    expect(kilo.entries).toEqual([])

    // The digest is taken from the links, not from what they point at.
    await put(outside, "kilo/mcp.json", JSON.stringify({ mcpServers: { changed: { command: "other" } } }))
    await put(outside, "claude/settings.json", "{}")
    await put(outside, "plugins/outside.ts", "changed")
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).toBe(result.configDigest)
  })

  it("refuses a repository root that is itself a link", async () => {
    const parent = await scratch()
    const outside = await scratch("domovoi-provider-outside-")
    await put(outside, ".mcp.json", JSON.stringify({ mcpServers: { stolen: { command: "outside-server" } } }))
    await put(outside, ".opencode/plugin/outside.ts", "outside")
    await put(outside, "kilo.json", JSON.stringify({ plugin: ["outside-plugin"] }))
    const root = join(parent, "repository")
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir")

    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(JSON.stringify(result)).not.toMatch(/outside-server|stolen|outside\.ts|outside-plugin/u)
    for (const entry of result.providers) {
      expect(toolInventoryProviderSchema.safeParse(entry).success).toBe(true)
      expect(entry.entries).toEqual([])
      expect(entry.files.length).toBeGreaterThan(0)
      expect(entry.files.every((file) => file.state === "unreadable" && file.reason === "symbolic-link")).toBe(true)
    }

    // The digest is taken from the link, not from what it points at.
    await put(outside, ".mcp.json", JSON.stringify({ mcpServers: { changed: { command: "other" } } }))
    await put(outside, ".opencode/plugin/outside.ts", "changed")
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).toBe(result.configDigest)
  })

  // lstat follows a link named with a trailing separator, so the root is
  // normalized before it is checked.
  it("refuses a linked repository root given with a trailing separator", async () => {
    const parent = await scratch()
    const outside = await scratch("domovoi-provider-outside-")
    await put(outside, ".mcp.json", JSON.stringify({ mcpServers: { stolen: { command: "outside-server" } } }))
    await put(outside, "kilo.json", JSON.stringify({ plugin: ["outside-plugin"] }))
    const root = join(parent, "repository")
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir")

    const result = await readRepositoryProviderConfig(`${root}${sep}`, { heldBack: true })
    expect(JSON.stringify(result)).not.toMatch(/outside-server|stolen|outside-plugin/u)
    for (const entry of result.providers) {
      expect(toolInventoryProviderSchema.safeParse(entry).success).toBe(true)
      expect(entry.entries).toEqual([])
      expect(entry.files.length).toBeGreaterThan(0)
      expect(entry.files.every((file) => file.state === "unreadable" && file.reason === "symbolic-link")).toBe(true)
    }
    expect(result.configDigest).toBe((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest)
  })

  it("reads a real repository root given with a trailing separator", async () => {
    const root = await scratch()
    await put(root, ".mcp.json", JSON.stringify({ mcpServers: { local: { command: "local-server" } } }))
    const result = await readRepositoryProviderConfig(`${root}${sep}`, { heldBack: true })
    expect(provider(result, "claude-code").entries.map((entry) => entry.kind === "tool-server" && entry.name)).toEqual(["local"])
    expect(result.configDigest).toBe((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest)
  })

  it("refuses a hard link, an oversized file and malformed JSON, JSONC and YAML, and reads the rest", async () => {
    const root = await scratch()
    const outside = await scratch("domovoi-provider-outside-")
    await put(outside, "settings.json", JSON.stringify({ env: { HARD_LINKED: "1" } }))
    await mkdir(join(root, ".claude"), { recursive: true })
    await link(join(outside, "settings.json"), join(root, ".claude", "settings.json"))
    await put(root, ".mcp.json", `{"mcpServers":{"big":{"command":"${"x".repeat(maximumRepositoryConfigFileBytes)}"}}}`)
    await put(root, "opencode.json", "{\"mcp\": {")
    await put(root, "kilo.jsonc", "{ /* unterminated")
    await put(root, ".kilocodemodes", "customModes: [\n  - slug: x\n")
    await put(root, ".kilo/mcp.json", JSON.stringify({ mcpServers: { fine: { command: "fine-mcp" } } }))

    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(JSON.stringify(result)).not.toContain("HARD_LINKED")
    expect(provider(result, "claude-code").files).toEqual([
      { path: ".mcp.json", source: "repository-file", state: "unreadable", reason: "too-large" },
      { path: ".claude/settings.json", source: "project-settings", state: "unreadable", reason: "hard-link" },
    ])
    expect(provider(result, "opencode").files).toEqual([{ path: "opencode.json", source: "project-settings", state: "unreadable", reason: "invalid-json" }])
    const kilo = provider(result, "kilo")
    expect(kilo.files).toEqual([
      { path: "kilo.jsonc", source: "project-settings", state: "unreadable", reason: "invalid-json" },
      { path: "opencode.json", source: "project-settings", state: "unreadable", reason: "invalid-json" },
      { path: ".kilo/mcp.json", source: "repository-file", state: "read" },
      { path: ".kilocodemodes", source: "repository-file", state: "unreadable", reason: "invalid-yaml" },
    ])
    expect(kilo.entries).toEqual([
      { kind: "tool-server", name: "fine", transport: "stdio", command: "fine-mcp", envKeys: [], file: ".kilo/mcp.json", startsAtSessionStart: true, heldBack: true },
    ])
    for (const entry of result.providers) expect(toolInventoryProviderSchema.safeParse(entry).success).toBe(true)
  })

  it("refuses a directory past its member or depth cap", async () => {
    const root = await scratch()
    for (let index = 0; index < 257; index += 1) await put(root, `.claude/commands/c${index}.md`, "c")
    await put(root, `.claude/agents/${Array.from({ length: 9 }, (_, index) => `d${index}`).join("/")}/a.md`, "a")
    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(provider(result, "claude-code").files).toEqual([
      { path: ".claude/commands", source: "repository-file", state: "unreadable", reason: "too-many-members" },
      { path: ".claude/agents", source: "repository-file", state: "unreadable", reason: "too-deep" },
    ])
    // Nothing past the cap is read, and the directory stays refused.
    await put(root, ".claude/agents/d0/d1/d2/d3/d4/d5/d6/d7/d8/a.md", "changed")
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).toBe(result.configDigest)
  })

  it("lists a hook whose command holds a control character, redacted from there on", async () => {
    const root = await scratch()
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [
        { type: "command", command: "npm test\nPGPASSWORD=prod-db-pass psql" },
        { type: "command", command: "curl -H X-Foo: \\\ns3cr3t-value tail" },
        { type: "command", command: "cmd", args: ["tab\there", "x"] },
        { type: "prompt", prompt: "Don't touch main\nand keep going" },
      ] }] },
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expectNoSecret(claude)
    expect(claude.omittedEntries).toBe(0)
    expect(claude.entries.map((entry) => (entry.kind === "hook" ? entry.command : undefined))).toEqual([
      "npm test [REDACTED]",
      "curl -H X-Foo: [REDACTED]",
      "cmd [REDACTED] x",
      "[REDACTED]",
    ])
  })

  it("escapes pattern characters in commands and keeps them in rules and matchers", async () => {
    const root = await scratch()
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command: "prettier --write src/*.ts" }] }] },
      permissions: { allow: ["Bash(git push *)"] },
      apiKeyHelper: "cat keys/{a,b}.txt",
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(claude.omittedEntries).toBe(0)
    expect(claude.entries).toEqual(expect.arrayContaining([
      {
        kind: "hook", event: "PreToolUse", matcher: "mcp__.*", command: "prettier --write src/\\*.ts",
        file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true,
      },
      { kind: "permission-rule", rule: "allow", detail: "Bash(git push *)", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
      { kind: "helper", name: "apiKeyHelper", command: "cat keys/\\{a,b}.txt", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
    ]))
  })

  // Redaction can write a longer text than it read; it still fits the
  // protocol's cap, so a hook the protocol would take unredacted is listed.
  it("lists a near-cap hook, rule and matcher whose redacted text grew", async () => {
    const root = await scratch()
    const rightToLeftOverride = String.fromCodePoint(0x202e)
    const hooks = [
      { type: "command", command: `echo ${"*".repeat(1_022)}` },
      { type: "command", command: `echo ${"a ".repeat(1_017)}${rightToLeftOverride}` },
      { type: "command", command: `echo x${"*".repeat(1_021)}` },
      { type: "command", command: "echo", args: ["*".repeat(2_042)] },
      { type: "command", command: "echo", args: ["*".repeat(2_041)] },
      { type: "prompt", prompt: `${"b ".repeat(1_020)}${rightToLeftOverride}` },
    ]
    for (const hook of hooks) expect([hook.command, ...(hook.args ?? []), hook.prompt ?? ""].join(" ").length).toBeLessThanOrEqual(2_048)
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ matcher: `${"x".repeat(243)} FOO=1`, hooks }] },
      permissions: { allow: [`${"x".repeat(1_010)} FOO=1`] },
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(claude.omittedEntries).toBe(0)
    const listed = claude.entries.flatMap((entry) => (entry.kind === "hook" ? [entry] : []))
    expect(listed.map((entry) => entry.command)).toEqual([
      "echo [REDACTED]",
      `echo${" a".repeat(1_016)} [REDACTED]`,
      `echo x${"\\*".repeat(1_021)}`,
      "echo [REDACTED]",
      `echo '${"*".repeat(2_041)}'`,
      `b${" b".repeat(1_018)} [REDACTED]`,
    ])
    expect(listed.every((entry) => entry.matcher === `${"x".repeat(243)} [REDACTED]`)).toBe(true)
    expect(claude.entries.filter((entry) => entry.kind === "permission-rule")).toEqual([
      { kind: "permission-rule", rule: "allow", detail: `${"x".repeat(1_010)} [REDACTED]`, file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
    ])
  })

  // An entry whose text was over its field's cap before redaction is listed
  // cut down to the cap, ending in the marker, not dropped and counted.
  it("lists an over-cap command and rule cut down to the cap", async () => {
    const root = await scratch()
    const command = `echo ${"a ".repeat(1_100)}a`
    const rule = `${"x ".repeat(600)}x`
    expect(command.length).toBeGreaterThan(2_048)
    expect(rule.length).toBeGreaterThan(1_024)
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command }, { type: "command", command: "echo", args: Array.from({ length: 1_100 }, () => "a") }] }] },
      permissions: { allow: [rule] },
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(claude.omittedEntries).toBe(0)
    const hooks = claude.entries.flatMap((entry) => (entry.kind === "hook" ? [entry.command] : []))
    const details = claude.entries.flatMap((entry) => (entry.kind === "permission-rule" ? [entry.detail] : []))
    expect(hooks).toEqual([`echo${" a".repeat(1_016)} [REDACTED]`, `echo${" a".repeat(1_016)} [REDACTED]`])
    expect(details).toEqual([`x${" x".repeat(506)} [REDACTED]`])
    for (const text of hooks) expect(text.length).toBeLessThanOrEqual(2_048)
    for (const text of details) expect(text.length).toBeLessThanOrEqual(1_024)
  })

  it("lists a hook whose sensitive flag follows a scheme word, its value redacted", async () => {
    const root = await scratch()
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [
        { type: "command", command: "curl Bearer --token s3cr3t-value https://example.com" },
        { type: "command", command: "curl", args: ["Bearer", "--token", "hunter2"] },
      ] }] },
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expectNoSecret(claude)
    expect(claude.omittedEntries).toBe(0)
    expect(claude.entries.map((entry) => (entry.kind === "hook" ? entry.command : undefined))).toEqual([
      "curl Bearer [REDACTED] [REDACTED] https://example.com",
      "curl Bearer [REDACTED] [REDACTED]",
    ])
  })

  it("drops and counts an entry the protocol backstop still refuses, and entries past the cap", async () => {
    const root = await scratch()
    const servers = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`s${index}`, { command: `server-${index}` }]))
    await put(root, ".mcp.json", JSON.stringify({ mcpServers: servers }))
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [
        { type: "command", command: "open 'https://example.com/p?a=1&mode=fast#t=zzz'" },
        { type: "command", command: "line one\nline two" },
        { type: "command", command: "pnpm lint" },
      ] }] },
      env: { "not a key": "x" },
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(claude.entries).toHaveLength(512)
    expect(claude.entries.filter((entry) => entry.kind === "hook")).toEqual([])
    // 600 servers and one good hook fill 512 places; the rest, the two refused
    // hooks and the malformed env key are counted.
    expect(claude.omittedEntries).toBe(600 + 1 - 512 + 2 + 1)
  })
})

describe("readRepositoryProviderConfig: config digest", () => {
  async function digest(root: string): Promise<string> {
    return (await readRepositoryProviderConfig(root, { heldBack: true })).configDigest
  }

  it("is stable, ignores other files and changes with every trust-relevant file", async () => {
    const root = await scratch()
    await put(root, ".mcp.json", JSON.stringify({ mcpServers: { a: { command: "a" } } }))
    await put(root, "README.md", "readme")
    const first = await digest(root)
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(await digest(root)).toBe(first)

    await put(root, "README.md", "changed")
    await put(root, "src/index.ts", "export {}")
    await put(root, "CLAUDE.md", "instructions load without trust")
    await put(root, "AGENTS.md", "instructions load without trust")
    await put(root, ".opencode/themes/dark.json", "{}")
    expect(await digest(root)).toBe(first)

    const seen = new Set([first])
    const changes: Array<[string, () => Promise<void>]> = [
      ["edit .mcp.json", () => put(root, ".mcp.json", JSON.stringify({ mcpServers: { a: { command: "b" } } }))],
      ["add .claude/settings.json", () => put(root, ".claude/settings.json", "{}")],
      ["add a plugin file", () => put(root, ".opencode/plugin/p.ts", "export {}")],
      ["edit the plugin file", () => put(root, ".opencode/plugin/p.ts", "export const x = 1")],
      ["add a nested command", () => put(root, ".opencode/command/deep/c.md", "c")],
      ["add opencode.json", () => put(root, "opencode.json", "{}")],
      ["add kilo.json", () => put(root, "kilo.json", "{}")],
      ["add .kilocodemodes", () => put(root, ".kilocodemodes", "customModes: []")],
      ["add .kilo/mcp.json", () => put(root, ".kilo/mcp.json", "{}")],
      ["add an agents skill", () => put(root, ".agents/skills/x/SKILL.md", "x")],
      ["add .opencode/package.json", () => put(root, ".opencode/package.json", "{}")],
      ...["config.json", ".kilo/config.json", ".kilocode/config.json"].flatMap((path): Array<[string, () => Promise<void>]> => [
        [`add ${path}`, () => put(root, path, "{}")],
        [`add a server to ${path}`, () => put(root, path, JSON.stringify({ mcp: { s: { type: "local", command: ["s"] } } }))],
      ]),
      ...["tui.json", "tui.jsonc", ".opencode/tui.json", ".opencode/tui.jsonc", ".kilo/tui.json", ".kilo/tui.jsonc", ".kilocode/tui.json", ".kilocode/tui.jsonc"]
        .flatMap((path): Array<[string, () => Promise<void>]> => [
          [`add ${path}`, () => put(root, path, "{}")],
          [`add a plugin to ${path}`, () => put(root, path, JSON.stringify({ plugin: ["p"] }))],
        ]),
      ["delete .mcp.json", () => rm(join(root, ".mcp.json"))],
    ]
    for (const [label, change] of changes) {
      await change()
      const next = await digest(root)
      expect(seen.has(next), label).toBe(false)
      seen.add(next)
    }
  })

  it("does not change with heldBack, and fits the inventory schema with its repository", async () => {
    const root = await scratch()
    await put(root, ".mcp.json", JSON.stringify({ mcpServers: { a: { command: "a" } } }))
    const held = await readRepositoryProviderConfig(root, { heldBack: true })
    const loaded = await readRepositoryProviderConfig(root, { heldBack: false })
    expect(loaded.configDigest).toBe(held.configDigest)
    expect(toolInventorySchema.safeParse({
      machine: { id: "machine-1", name: "m", platform: "darwin", arch: "arm64", version: "0.0.0" },
      repository: { projectId: "project-1", root: "/repo", configDigest: held.configDigest, trust: { state: "untrusted", reason: "not-trusted" } },
      providers: held.providers,
    }).success).toBe(true)
  })
})
