import { execFileSync } from "node:child_process"
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { performance } from "node:perf_hooks"
import { dirname, join, sep } from "node:path"

import { toolInventoryProviderSchema, toolInventorySchema, type ToolInventoryFile, type ToolInventoryProvider } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { inventoryShellWords } from "./inventory-redaction.js"
import { maximumRepositoryConfigFileBytes, readRepositoryProviderConfig } from "./repository-provider-config.js"
import { maximumRepositoryTomlDepth, maximumRepositoryTomlParseMilliseconds, parseRepositoryToml, RepositoryTomlTooSlowError } from "./repository-toml.js"
import {
  escapedBlankTexts, generatedShellReadingTexts, hiddenTriggerCredential, hiddenTriggerPlacements, hiddenTriggerWords, quotedStringTexts, sameWordCases,
  sameWordCredentials, sameWordPlacements, sameWordWrappers, shellReadingTexts, unsettledViewTexts, viewCases, viewCredential, viewPlacements,
  viewSpellings, viewTexts,
} from "./test-hidden-triggers.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { adversarialCommands, adversarialTomlFiles, nearLinearGrowth, workGrowth } from "./test-work.js"

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

const secrets = [
  "s3cr3t-value", "hunter2", "prod-db-pass", "tok-abc", "q-secret", "env-secret", "opaque-header-secret", "opaque-fragment-secret", "inline-bearer-secret",
]

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
        command: "npx server [REDACTED]", envKeys: ["API_TOKEN", "REGION"],
      },
      {
        kind: "tool-server", name: "remote", transport: "http", file: ".mcp.json", startsAtSessionStart: true, heldBack: true,
        host: "mcp.example.com:8443", envKeys: [],
      },
      { kind: "hook", event: "SessionStart", command: "[REDACTED]", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
      { kind: "hook", event: "PreToolUse", matcher: "Bash", command: "[REDACTED]", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
      {
        kind: "hook", event: "PostToolUse", command: "curl [REDACTED]",
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
      { kind: "tool-server", name: "db", transport: "stdio", command: "db-mcp [REDACTED]", envKeys: ["PGPASSWORD"], file: "opencode.jsonc", startsAtSessionStart: true, heldBack: true },
      { kind: "tool-server", name: "docs", transport: "http", host: "docs.example.com", envKeys: [], file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
      { kind: "plugin", name: "opencode-helper@1.0.0", file: "opencode.jsonc", startsAtSessionStart: true, heldBack: true },
      { kind: "permission-rule", rule: "ask", detail: "bash git push *", file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
      { kind: "permission-rule", rule: "allow", detail: "edit", file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
      { kind: "helper", name: "formatter fmt", command: "fmt [REDACTED]", file: "opencode.jsonc", startsAtSessionStart: false, heldBack: true },
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

// Codex loads a repository's .codex/config.toml, .codex/hooks.json and
// .codex/rules once the project is trusted, and skills from .codex/skills and
// .agents/skills (codex-rs config loader, hooks discovery and skill roots at
// rust-v0.156.1).
describe("readRepositoryProviderConfig: Codex", () => {
  const configToml = [
    "approval_policy = \"never\"",
    "sandbox_mode = \"danger-full-access\"",
    "default_permissions = \"workspace\"",
    "# Codex ignores these in a project file, so they are not listed.",
    "notify = [\"notify-send\", \"--token\", \"tok-abc\"]",
    "model_provider = \"elsewhere\"",
    "",
    "[sandbox_workspace_write]",
    "writable_roots = [\"/var/data\", \"../shared\"]",
    "network_access = true",
    "",
    "[shell_environment_policy]",
    "inherit = \"all\"",
    "ignore_default_excludes = true",
    "set = { DATABASE_URL = \"postgres://u:hunter2@db/x\", DEBUG = \"1\" }",
    "",
    "[model_providers.elsewhere]",
    "base_url = \"https://elsewhere.example.com/v1\"",
    "env_key = \"OPENAI_API_KEY\"",
    "",
    "[mcp_servers.local]",
    "command = \"npx\"",
    "args = [\"server\", \"--api-key\", \"s3cr3t-value\"]",
    "env = { API_TOKEN = \"env-secret\", REGION = \"eu\" }",
    "env_vars = [\"GITHUB_TOKEN\", { name = \"LOCAL_ONLY\", source = \"local\" }]",
    "default_tools_approval_mode = \"approve\"",
    "",
    "[mcp_servers.local.tools.deploy]",
    "approval_mode = \"approve\"",
    "",
    "[mcp_servers.remote]",
    "url = \"https://user:tok-abc@mcp.example.com:8443/v1?key=q-secret\"",
    "bearer_token = \"inline-bearer-secret\"",
    "bearer_token_env_var = \"REMOTE_TOKEN\"",
    "http_headers = { Authorization = \"Bearer opaque-header-secret\" }",
    "env_http_headers = { \"X-Api-Key\" = \"REMOTE_API_KEY\" }",
    "http_headers_helper = \"print-headers --token tok-abc\"",
    "enabled = false",
    "",
    "[plugins.\"formatter@market\"]",
    "enabled = true",
    "",
    "[plugins.\"off@market\"]",
    "enabled = false",
    "",
    "[[hooks.SessionStart]]",
    "hooks = [{ type = \"command\", command = \"NODE_ENV=production pnpm build\" }]",
    "",
    "[[hooks.PreToolUse]]",
    "matcher = \"shell\"",
    "hooks = [",
    "  { type = \"command\", command = \"./check.sh\", commandWindows = \"check.cmd\" },",
    "  { type = \"mcp_tool\", server = \"local\", tool = \"audit\" },",
    "  { type = \"prompt\" },",
    "]",
    "",
    "# Codex reads hook state from the person's own config only.",
    "[hooks.state.\"file:/repo/.codex/config.toml:pre_tool_use:0:0\"]",
    "trusted_hash = \"sha256:abc\"",
    "",
  ].join("\n")

  it("lists servers, hooks, env keys, rules, helpers and plugins from config.toml, redacted", async () => {
    const root = await scratch()
    await put(root, ".codex/config.toml", configToml)

    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    const codex = provider(result, "codex")
    expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
    expectNoSecret(result)
    expect(JSON.stringify(codex)).not.toMatch(/notify-send|elsewhere|OPENAI_API_KEY|trusted_hash|sha256:abc/u)
    expect(codex.files).toEqual([{ path: ".codex/config.toml", source: "project-settings", state: "read" }])
    expect(codex.omittedEntries).toBe(0)
    const file = ".codex/config.toml"
    const rule = (name: string, detail: string) => ({ kind: "permission-rule", rule: name, detail, file, startsAtSessionStart: false, heldBack: true })
    expect(codex.entries).toEqual([
      {
        kind: "tool-server", name: "local", transport: "stdio", file, startsAtSessionStart: true, heldBack: true,
        command: "npx server [REDACTED]", envKeys: ["API_TOKEN", "REGION", "GITHUB_TOKEN", "LOCAL_ONLY"],
      },
      rule("default_tools_approval_mode", "local approve"),
      rule("approval_mode", "local deploy approve"),
      // A remote server names the variables whose values Codex sends to it.
      {
        kind: "tool-server", name: "remote", transport: "http", file, startsAtSessionStart: false, heldBack: true,
        host: "mcp.example.com:8443", envKeys: ["REMOTE_TOKEN", "REMOTE_API_KEY"],
      },
      { kind: "helper", name: "http_headers_helper remote", command: "print-headers [REDACTED]", file, startsAtSessionStart: false, heldBack: true },
      { kind: "hook", event: "SessionStart", command: "[REDACTED]", file, startsAtSessionStart: true, heldBack: true },
      { kind: "hook", event: "PreToolUse", matcher: "shell", command: "./check.sh", file, startsAtSessionStart: false, heldBack: true },
      { kind: "hook", event: "PreToolUse", matcher: "shell", command: "check.cmd", file, startsAtSessionStart: false, heldBack: true },
      { kind: "hook", event: "PreToolUse", matcher: "shell", command: "local audit", file, startsAtSessionStart: false, heldBack: true },
      { kind: "env-key", key: "DATABASE_URL", file, startsAtSessionStart: false, heldBack: true },
      { kind: "env-key", key: "DEBUG", file, startsAtSessionStart: false, heldBack: true },
      rule("approval_policy", "never"),
      rule("sandbox_mode", "danger-full-access"),
      rule("default_permissions", "workspace"),
      rule("sandbox_workspace_write.writable_roots", "/var/data"),
      rule("sandbox_workspace_write.writable_roots", "../shared"),
      rule("sandbox_workspace_write.network_access", "true"),
      rule("shell_environment_policy.inherit", "all"),
      rule("shell_environment_policy.ignore_default_excludes", "true"),
      { kind: "plugin", name: "formatter@market", file, startsAtSessionStart: true, heldBack: true },
    ])
  })

  it("lists a granular approval policy by the flows it allows", async () => {
    const root = await scratch()
    await put(root, ".codex/config.toml", "[approval_policy.granular]\nsandbox_approval = true\nrules = true\nmcp_elicitations = false\n")
    const codex = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(codex.omittedEntries).toBe(0)
    expect(codex.entries).toEqual([
      { kind: "permission-rule", rule: "approval_policy", detail: "granular sandbox_approval rules", file: ".codex/config.toml", startsAtSessionStart: false, heldBack: true },
    ])
  })

  // A permission profile grants filesystem, workspace-root and network access,
  // and the shell's filters choose which of the person's variables reach a
  // command: each grant and filter is listed, never a variable's value.
  it("lists a named permission profile's grants and the shell's variable filters", async () => {
    const root = await scratch()
    await put(root, ".codex/config.toml", [
      "default_permissions = \"wide\"",
      "",
      "[permissions.base]",
      "description = \"shared base\"",
      "[permissions.base.filesystem]",
      "\"/var/cache\" = \"read\"",
      "",
      "[permissions.wide]",
      "extends = \"base\"",
      "[permissions.wide.workspace_roots]",
      "\"../sibling\" = true",
      "\"../off\" = false",
      "[permissions.wide.filesystem]",
      "\"/\" = \"write\"",
      "glob_scan_max_depth = 3",
      "\"/home\" = { \".ssh\" = \"deny\", \"projects\" = \"write\" }",
      "[permissions.wide.network]",
      "enabled = true",
      "mode = \"full\"",
      "proxy_url = \"http://proxy.example.com:3128\"",
      "socks_url = \"socks5://user:hunter2@socks.example.com:1080\"",
      "dangerously_allow_all_unix_sockets = true",
      "[permissions.wide.network.domains]",
      "\"*.example.com\" = \"allow\"",
      "\"evil.example\" = \"deny\"",
      "[permissions.wide.network.unix_sockets]",
      "\"/var/run/docker.sock\" = \"allow\"",
      "[permissions.wide.network.mitm.hooks.inject]",
      "host = \"api.example.com\"",
      "methods = [\"GET\"]",
      "path_prefixes = [\"/\"]",
      "action = [\"add\"]",
      "",
      "[shell_environment_policy]",
      "include_only = [\"DEPLOY_TOKEN\", \"PATH\"]",
      "exclude = [\"AWS_*\"]",
      "[shell_environment_policy.filters]",
      "\"GITHUB_*\" = \"include\"",
      "",
    ].join("\n"))
    const codex = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
    expectNoSecret(codex)
    const rule = (name: string, detail: unknown) => ({ kind: "permission-rule", rule: name, detail, file: ".codex/config.toml", startsAtSessionStart: false, heldBack: true })
    expect(codex.entries).toEqual([
      rule("default_permissions", "wide"),
      rule("permissions.filesystem", "base /var/cache read"),
      rule("permissions.extends", "wide base"),
      rule("permissions.workspace_roots", "wide ../sibling true"),
      rule("permissions.workspace_roots", "wide ../off false"),
      rule("permissions.filesystem", "wide / write"),
      rule("permissions.filesystem", "wide /home .ssh deny"),
      rule("permissions.filesystem", "wide /home projects write"),
      rule("permissions.network.enabled", "wide true"),
      rule("permissions.network.mode", "wide full"),
      rule("permissions.network.proxy_url", "wide http://proxy.example.com:3128"),
      rule("permissions.network.socks_url", expect.stringMatching(/^wide socks5:\/\/\S*\[REDACTED\]/u)),
      rule("permissions.network.dangerously_allow_all_unix_sockets", "wide true"),
      rule("permissions.network.domains", "wide *.example.com allow"),
      rule("permissions.network.domains", "wide evil.example deny"),
      rule("permissions.network.unix_sockets", "wide /var/run/docker.sock allow"),
      rule("shell_environment_policy.include_only", "DEPLOY_TOKEN"),
      rule("shell_environment_policy.include_only", "PATH"),
      rule("shell_environment_policy.exclude", "AWS_*"),
      rule("shell_environment_policy.filters", "GITHUB_* include"),
    ])
    // Man-in-the-middle hooks are not read here, so they are counted.
    expect(codex.omittedEntries).toBe(1)
  })

  // Ruling Q114: an instruction override is listed by its key, and a file by
  // its path, never by its text. Codex resolves the file's path against the
  // .codex folder. A file in the repository is hashed like any other; one
  // outside it, or reached through a link, refuses trust.
  const instructionRule = (rule: string, detail: string) => ({
    kind: "permission-rule", rule, detail, file: ".codex/config.toml", startsAtSessionStart: false, heldBack: true,
  })

  it("lists instruction overrides without their text and pins the file one names", async () => {
    const root = await scratch()
    await put(root, ".codex/config.toml", [
      "model_instructions_file = \"../docs/policy.txt\"",
      "instructions = \"INLINE-INSTRUCTIONS-TEXT\"",
      "developer_instructions = \"\"\"DEVELOPER-INSTRUCTIONS-TEXT\"\"\"",
      "",
    ].join("\n"))
    await put(root, "docs/policy.txt", "POLICY-FILE-TEXT")
    const first = await readRepositoryProviderConfig(root, { heldBack: true })
    const codex = provider(first, "codex")
    expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
    expect(JSON.stringify(first)).not.toMatch(/INLINE-INSTRUCTIONS-TEXT|DEVELOPER-INSTRUCTIONS-TEXT|POLICY-FILE-TEXT/u)
    expect(codex.files).toEqual([
      { path: ".codex/config.toml", source: "project-settings", state: "read" },
      { path: "docs/policy.txt", source: "repository-file", state: "read" },
    ])
    expect(codex.entries).toEqual([
      instructionRule("instructions", "inline"),
      instructionRule("developer_instructions", "inline"),
      instructionRule("model_instructions_file", "docs/policy.txt"),
    ])
    expect(codex.omittedEntries).toBe(0)
    expect(first.trustRefusals).toEqual([])
    await put(root, "docs/policy.txt", "CHANGED-POLICY-FILE-TEXT")
    const changed = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(changed.configDigest).not.toBe(first.configDigest)
    await rm(join(root, "docs", "policy.txt"))
    const missing = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(new Set([first.configDigest, changed.configDigest, missing.configDigest]).size).toBe(3)
    expect(provider(missing, "codex").files).toEqual([{ path: ".codex/config.toml", source: "project-settings", state: "read" }])

    // The same caps as every other file.
    await put(root, "docs/policy.txt", "x".repeat(maximumRepositoryConfigFileBytes + 1))
    const large = await readRepositoryProviderConfig(root, { heldBack: true })
    expect(provider(large, "codex").files[1]).toEqual({ path: "docs/policy.txt", source: "repository-file", state: "unreadable", reason: "too-large" })
  })

  it("refuses trust for an instruction file outside the repository or through a link", async () => {
    const root = await scratch()
    const outside = await scratch("domovoi-provider-outside-")
    await put(outside, "policy.txt", "OUTSIDE-POLICY-TEXT")
    const dir = process.platform === "win32" ? "junction" : "dir"
    await symlink(join(outside, "policy.txt"), join(root, "linked.txt"))
    await symlink(outside, join(root, "linked-docs"), dir)
    await put(outside, "hard.txt", "HARD-LINKED-TEXT")
    await link(join(outside, "hard.txt"), join(root, "hard.txt"))
    const cases: Array<[string, string, { file?: object }]> = [
      [join(outside, "policy.txt"), join(outside, "policy.txt"), {}],
      ["../../outside.txt", "../../outside.txt", {}],
      ["~/policy.txt", "~/policy.txt", {}],
      ["../linked.txt", "linked.txt", { file: { path: "linked.txt", source: "repository-file", state: "unreadable", reason: "symbolic-link" } }],
      ["../linked-docs/policy.txt", "linked-docs/policy.txt", { file: { path: "linked-docs/policy.txt", source: "repository-file", state: "unreadable", reason: "symbolic-link" } }],
      ["../hard.txt", "hard.txt", { file: { path: "hard.txt", source: "repository-file", state: "unreadable", reason: "hard-link" } }],
    ]
    for (const [written, shown, { file }] of cases) {
      await put(root, ".codex/config.toml", `model_instructions_file = ${JSON.stringify(written)}\n`)
      const result = await readRepositoryProviderConfig(root, { heldBack: true })
      const codex = provider(result, "codex")
      expect(toolInventoryProviderSchema.safeParse(codex).success, written).toBe(true)
      expect(JSON.stringify(result), written).not.toMatch(/OUTSIDE-POLICY-TEXT|HARD-LINKED-TEXT/u)
      expect(result.trustRefusals, written).toEqual([{ provider: "codex", reason: "instructions-outside", path: shown }])
      expect(codex.entries, written).toEqual([instructionRule("model_instructions_file", shown)])
      expect(codex.files, written).toEqual([{ path: ".codex/config.toml", source: "project-settings", state: "read" }, ...(file ? [file] : [])])
      // What lies outside is never read, so a change there changes nothing.
      await put(outside, "policy.txt", "OUTSIDE-POLICY-TEXT again")
      expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest, written).toBe(result.configDigest)
    }

    await put(root, ".codex/config.toml", "model_instructions_file = 7\n")
    const odd = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(odd.entries).toEqual([])
    expect(odd.omittedEntries).toBe(1)
  })

  // A repository names the instruction file, so its path is shown redacted
  // and within the path cap, the same text in the file record, the rule and
  // the refusal. The file is still read and pinned by its own path.
  it("shows an instruction file's path redacted wherever it is listed", async () => {
    const root = await scratch()
    const outside = await scratch("domovoi-provider-outside-")
    const canary = "REVIEW_PATH_CANARY"
    const name = `policy TOKEN=${canary}.txt`
    await put(root, `docs/${name}`, "POLICY-FILE-TEXT")
    await put(root, " lead.txt", "LEAD-FILE-TEXT")
    await put(outside, "policy.txt", "OUTSIDE-POLICY-TEXT")
    await mkdir(join(root, "linked"))
    await symlink(join(outside, "policy.txt"), join(root, "linked", name))
    const cases: Array<[string, string, ToolInventoryFile]> = [
      [`../docs/${name}`, "docs/policy [REDACTED]", { path: "docs/policy [REDACTED]", source: "repository-file", state: "read" }],
      [`../linked/${name}`, "linked/policy [REDACTED]", { path: "linked/policy [REDACTED]", source: "repository-file", state: "unreadable", reason: "symbolic-link" }],
      // A path the protocol refuses as written is the marker.
      ["../ lead.txt", "[REDACTED]", { path: "[REDACTED]", source: "repository-file", state: "read" }],
    ]
    for (const [written, shown, file] of cases) {
      await put(root, ".codex/config.toml", `model_instructions_file = ${JSON.stringify(written)}\n`)
      const result = await readRepositoryProviderConfig(root, { heldBack: true })
      const codex = provider(result, "codex")
      expect(toolInventoryProviderSchema.safeParse(codex).success, written).toBe(true)
      expect(JSON.stringify(result), written).not.toMatch(new RegExp(`${canary}|POLICY-FILE-TEXT|LEAD-FILE-TEXT`, "u"))
      expect(codex.files, written).toEqual([{ path: ".codex/config.toml", source: "project-settings", state: "read" }, file])
      expect(codex.entries, written).toEqual([instructionRule("model_instructions_file", shown)])
      expect(result.trustRefusals, written).toEqual(file.state === "unreadable" ? [{ provider: "codex", reason: "instructions-outside", path: shown }] : [])
    }
    await put(root, ".codex/config.toml", `model_instructions_file = ${JSON.stringify(`../docs/${name}`)}\n`)
    const first = await readRepositoryProviderConfig(root, { heldBack: true })
    await put(root, `docs/${name}`, "CHANGED-POLICY-FILE-TEXT")
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).not.toBe(first.configDigest)
  })

  // An instruction file that is also a path in scope is listed once.
  it("lists an instruction file that is also a Codex file once", async () => {
    const root = await scratch()
    await put(root, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "stop-hook" }] }] } }))
    await put(root, ".codex/skills/mine/SKILL.md", "mine")
    for (const written of ["hooks.json", "skills"]) {
      await put(root, ".codex/config.toml", `model_instructions_file = ${JSON.stringify(written)}\n`)
      const codex = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
      expect(toolInventoryProviderSchema.safeParse(codex).success, written).toBe(true)
      const paths = codex.files.map((file) => file.path)
      expect(paths, written).toEqual([...new Set(paths)])
    }
  })

  // A header helper prints the headers Codex sends, and a header's name and
  // value need no word the redaction knows: every argument is cut, and the
  // helper is listed by its program.
  it("lists a header helper by its program, every argument cut", async () => {
    const root = await scratch()
    const canary = "REVIEW_CANARY_4821"
    const helpers: Array<[string, string]> = [
      ["echo", `echo '{"X-Custom":"${canary}"}'`],
      ["printf", `printf '%s' '{"X-Custom":"${canary}"}'`],
      ["spaced", `'/opt/header tools/print' ${canary}`],
      ["bare", "print-headers"],
      ["assigned", `HEADER=${canary} print-headers`],
      ["piped", `cat headers.json | tr -d ${canary}`],
      ["script", `sh -c 'echo ${canary}'`],
      ["subshell", `(echo ${canary})`],
      ["expanded", `$(echo ${canary}) x`],
      // A word that starts with an unquoted `#` opens a shell comment: it is
      // not the program.
      ["comment", `#${canary}\nprintf '%s' '{"X-Custom":"${canary}"}'`],
      ["indented", `  #${canary}`],
      ["joined", `\\\n#${canary}\nprint-headers`],
      ["quoted", `'#print' ${canary}`],
    ]
    await put(root, ".codex/config.toml", [
      ...helpers.map(([name, helper]) => (
        `[mcp_servers.${name}]\nurl = "https://mcp.example.test"\nhttp_headers_helper = ${JSON.stringify(helper)}\n`
      )),
      // The review's multiline literal string.
      `[mcp_servers.multiline]\nurl = "https://mcp.example.test"\nhttp_headers_helper = '''\n#${canary}\nprintf '%s' '{"X-Custom":"${canary}"}'\n'''\n`,
    ].join("\n"))
    const codex = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
    expect(JSON.stringify(codex)).not.toContain(canary)
    expect(codex.omittedEntries).toBe(0)
    expect(codex.entries.flatMap((entry) => (entry.kind === "helper" ? [[entry.name, entry.command]] : []))).toEqual([
      ["http_headers_helper echo", "echo [REDACTED]"],
      ["http_headers_helper printf", "printf [REDACTED]"],
      ["http_headers_helper spaced", "'/opt/header tools/print' [REDACTED]"],
      ["http_headers_helper bare", "print-headers"],
      ["http_headers_helper assigned", "[REDACTED]"],
      ["http_headers_helper piped", "cat [REDACTED]"],
      ["http_headers_helper script", "sh [REDACTED]"],
      ["http_headers_helper subshell", "[REDACTED]"],
      ["http_headers_helper expanded", "[REDACTED]"],
      ["http_headers_helper comment", "[REDACTED]"],
      ["http_headers_helper indented", "[REDACTED]"],
      ["http_headers_helper joined", "[REDACTED]"],
      ["http_headers_helper quoted", "'#print' [REDACTED]"],
      ["http_headers_helper multiline", "[REDACTED]"],
    ])
  })

  it("lists hooks from hooks.json and counts what it cannot read", async () => {
    const root = await scratch()
    await put(root, ".codex/hooks.json", JSON.stringify({
      description: "repository hooks",
      hooks: {
        Stop: [{ hooks: [
          { type: "command", command: "pnpm lint", timeout: 30 },
          { type: "command", command: "npm test\nPGPASSWORD=prod-db-pass psql", command_windows: "npm.cmd test" },
          // Codex skips prompt and agent hooks, so there is nothing to list.
          { type: "agent" },
          { type: "unknown" },
        ] }],
        PostToolUse: "not a list",
      },
    }))
    const codex = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
    expectNoSecret(codex)
    expect(codex.files).toEqual([{ path: ".codex/hooks.json", source: "project-settings", state: "read" }])
    const hook = (command: string) => ({ kind: "hook", event: "Stop", command, file: ".codex/hooks.json", startsAtSessionStart: false, heldBack: true })
    expect(codex.entries).toEqual([hook("pnpm lint"), hook("npm test [REDACTED]"), hook("npm.cmd test")])
    expect(codex.omittedEntries).toBe(2)
  })

  it("names skills from .codex/skills and .agents/skills and keeps rules in the digest", async () => {
    const root = await scratch()
    await put(root, ".codex/skills/deploy/SKILL.md", "---\nname: deploy\n---\nDeploy.")
    await put(root, ".agents/skills/review/SKILL.md", "---\nname: review\n---\nReview.")
    await put(root, ".codex/rules/default.rules", "prefix_rule(pattern = [\"git\", \"push\"], decision = \"allow\")\n")
    const result = await readRepositoryProviderConfig(root, { heldBack: true })
    const codex = provider(result, "codex")
    expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
    expect(codex.files).toEqual([
      { path: ".codex/rules", source: "repository-file", state: "read" },
      { path: ".codex/skills", source: "repository-file", state: "read" },
      { path: ".agents/skills", source: "repository-file", state: "read" },
    ])
    expect(codex.entries).toEqual([
      { kind: "skill", name: "deploy", file: ".codex/skills", startsAtSessionStart: false, heldBack: true },
      { kind: "skill", name: "review", file: ".agents/skills", startsAtSessionStart: false, heldBack: true },
    ])
    await put(root, ".codex/rules/default.rules", "prefix_rule(pattern = [\"git\"], decision = \"allow\")\n")
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).not.toBe(result.configDigest)
  })

  // The counted growth tests cannot see every kind of slow input, so a parse
  // that takes longer than its time limit is refused. The clock is stepped,
  // never slept on: each read of it advances by `step` milliseconds.
  it("refuses TOML whose parse takes longer than its time limit, and reads the rest", async () => {
    const stepped = (step: number) => {
      let now = 0
      return vi.spyOn(performance, "now").mockImplementation(() => {
        now += step
        return now
      })
    }
    const text = "sandbox_mode = \"read-only\"\n"
    const limit = maximumRepositoryTomlParseMilliseconds
    try {
      stepped(limit)
      expect(parseRepositoryToml(text)).toEqual({ sandbox_mode: "read-only" })
      stepped(limit + 1)
      expect(() => parseRepositoryToml(text)).toThrow(RepositoryTomlTooSlowError)

      const root = await scratch()
      await put(root, ".codex/config.toml", text)
      await put(root, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "pnpm lint" }] }] } }))
      const codex = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
      expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
      expect(codex.files).toEqual([
        { path: ".codex/config.toml", source: "project-settings", state: "unreadable", reason: "too-slow" },
        { path: ".codex/hooks.json", source: "project-settings", state: "read" },
      ])
      expect(codex.entries.map((entry) => entry.kind)).toEqual(["hook"])
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("refuses malformed TOML and TOML nested past its depth cap, and reads the rest", async () => {
    const root = await scratch()
    await put(root, ".codex/config.toml", "[mcp_servers.x\ncommand = \"a\"\n")
    await put(root, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "pnpm lint" }] }] } }))
    const first = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(toolInventoryProviderSchema.safeParse(first).success).toBe(true)
    expect(first.files).toEqual([
      { path: ".codex/config.toml", source: "project-settings", state: "unreadable", reason: "invalid-toml" },
      { path: ".codex/hooks.json", source: "project-settings", state: "read" },
    ])
    expect(first.entries.map((entry) => entry.kind === "hook" && entry.command)).toEqual(["pnpm lint"])

    const depth = maximumRepositoryTomlDepth
    await put(root, ".codex/config.toml", `sandbox_mode = "read-only"\nnested = ${"[".repeat(depth + 1)}${"]".repeat(depth + 1)}\n`)
    const deep = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(deep.files[0]).toEqual({ path: ".codex/config.toml", source: "project-settings", state: "unreadable", reason: "invalid-toml" })
    await put(root, ".codex/config.toml", `sandbox_mode = "read-only"\nnested = ${"[".repeat(depth)}${"]".repeat(depth)}\n`)
    const atCap = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(atCap.files[0]).toEqual({ path: ".codex/config.toml", source: "project-settings", state: "read" })
    expect(atCap.entries[0]).toEqual({
      kind: "permission-rule", rule: "sandbox_mode", detail: "read-only", file: ".codex/config.toml", startsAtSessionStart: false, heldBack: true,
    })
  })

  it("never follows a link, and refuses a hard link and an oversized file", async () => {
    const root = await scratch()
    const outside = await scratch("domovoi-provider-outside-")
    await put(outside, "codex/config.toml", "[mcp_servers.stolen]\ncommand = \"outside-server\"\n")
    await put(outside, "codex/skills/outside/SKILL.md", "outside")
    await symlink(join(outside, "codex"), join(root, ".codex"), process.platform === "win32" ? "junction" : "dir")
    const linked = await readRepositoryProviderConfig(root, { heldBack: true })
    const codex = provider(linked, "codex")
    expect(JSON.stringify(linked)).not.toMatch(/outside-server|stolen|outside/u)
    expect(codex.files).toEqual([
      { path: ".codex/config.toml", source: "project-settings", state: "unreadable", reason: "symbolic-link" },
      { path: ".codex/hooks.json", source: "project-settings", state: "unreadable", reason: "symbolic-link" },
      { path: ".codex/rules", source: "repository-file", state: "unreadable", reason: "symbolic-link" },
      { path: ".codex/skills", source: "repository-file", state: "unreadable", reason: "symbolic-link" },
    ])
    expect(codex.entries).toEqual([])
    await put(outside, "codex/config.toml", "sandbox_mode = \"read-only\"\n")
    expect((await readRepositoryProviderConfig(root, { heldBack: true })).configDigest).toBe(linked.configDigest)

    const other = await scratch()
    await put(outside, "config.toml", "[shell_environment_policy]\nset = { HARD_LINKED = \"1\" }\n")
    await mkdir(join(other, ".codex"), { recursive: true })
    await link(join(outside, "config.toml"), join(other, ".codex", "config.toml"))
    await put(other, ".codex/hooks.json", `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"${"x".repeat(maximumRepositoryConfigFileBytes)}"}]}]}}`)
    const refused = await readRepositoryProviderConfig(other, { heldBack: true })
    expect(JSON.stringify(refused)).not.toContain("HARD_LINKED")
    expect(provider(refused, "codex").files).toEqual([
      { path: ".codex/config.toml", source: "project-settings", state: "unreadable", reason: "hard-link" },
      { path: ".codex/hooks.json", source: "project-settings", state: "unreadable", reason: "too-large" },
    ])
  })

  // Q92 and Q99: an over-cap command and one the protocol backstop would
  // refuse are listed cut, ending in the marker, not dropped.
  it("lists an over-cap hook and one with a hidden trigger cut, none omitted", async () => {
    const root = await scratch()
    const long = `echo ${"a ".repeat(1_100)}a`
    await put(root, ".codex/config.toml", [
      "[[hooks.Stop]]",
      `hooks = [{ type = "command", command = ${JSON.stringify(long)} }, { type = "command", command = "curl 'https://host Token swordfish tail'" }]`,
      "",
    ].join("\n"))
    const codex = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex")
    expect(toolInventoryProviderSchema.safeParse(codex).success).toBe(true)
    expect(JSON.stringify(codex)).not.toContain("swordfish")
    expect(codex.omittedEntries).toBe(0)
    expect(codex.entries.map((entry) => (entry.kind === "hook" ? entry.command : undefined))).toEqual([
      `echo${" a".repeat(1_016)} [REDACTED]`,
      "curl 'https://host [REDACTED]'",
    ])
  })

  it("changes the digest with every Codex path in scope and nothing else", async () => {
    const root = await scratch()
    const digest = async () => (await readRepositoryProviderConfig(root, { heldBack: true })).configDigest
    const first = await digest()
    await put(root, ".codex/notes.md", "not read by Codex")
    await put(root, "AGENTS.md", "instructions load without trust")
    expect(await digest()).toBe(first)
    const seen = new Set([first])
    const changes: Array<[string, () => Promise<void>]> = [
      ["add .codex/config.toml", () => put(root, ".codex/config.toml", "sandbox_mode = \"read-only\"\n")],
      ["add a comment to config.toml", () => put(root, ".codex/config.toml", "# comment\nsandbox_mode = \"read-only\"\n")],
      ["add .codex/hooks.json", () => put(root, ".codex/hooks.json", "{}")],
      ["add a rules file", () => put(root, ".codex/rules/a.rules", "")],
      ["edit the rules file", () => put(root, ".codex/rules/a.rules", "prefix_rule(pattern = [\"ls\"], decision = \"allow\")")],
      ["add a Codex skill", () => put(root, ".codex/skills/x/SKILL.md", "x")],
      ["delete config.toml", () => rm(join(root, ".codex/config.toml"))],
    ]
    for (const [label, change] of changes) {
      await change()
      const next = await digest()
      expect(seen.has(next), label).toBe(false)
      seen.add(next)
    }
  })

  // Codex skips a project .codex folder that is its own CODEX_HOME, by path
  // or by canonical path (discover_project_layers at rust-v0.156.1), so a
  // repository at the person's home does not list their own configuration.
  it("skips a .codex folder that is Codex's own home, by path or through a link to it", async () => {
    const root = await scratch()
    await put(root, ".codex/config.toml", "[mcp_servers.personal]\ncommand = \"personal-server\"\n")
    await put(root, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "personal-hook" }] }] } }))
    await put(root, ".codex/rules/default.rules", "prefix_rule(pattern = [\"ls\"], decision = \"allow\")\n")
    await put(root, ".codex/skills/mine/SKILL.md", "mine")
    const elsewhere = await scratch("domovoi-provider-home-")
    const linkedHome = join(elsewhere, "codex-home")
    await symlink(join(root, ".codex"), linkedHome, process.platform === "win32" ? "junction" : "dir")
    const read = async (codexHome: string) => readRepositoryProviderConfig(root, { heldBack: true, codexHome })
    for (const codexHome of [join(root, ".codex"), linkedHome]) {
      const result = await read(codexHome)
      const codex = provider(result, "codex")
      expect(JSON.stringify(result)).not.toMatch(/personal|mine/u)
      expect(codex.files).toEqual([])
      expect(codex.entries).toEqual([])
      await put(root, ".codex/config.toml", "[mcp_servers.personal]\ncommand = \"personal-server-2\"\n")
      expect((await read(codexHome)).configDigest).toBe(result.configDigest)
    }
    // CODEX_HOME from the environment, as Codex reads it.
    vi.stubEnv("CODEX_HOME", join(root, ".codex"))
    expect(provider(await readRepositoryProviderConfig(root, { heldBack: true }), "codex").files).toEqual([])
    vi.unstubAllEnvs()
    // Another home: the repository's folder is read.
    const other = provider(await read(join(elsewhere, "other-home")), "codex")
    expect(other.files.map((file) => file.path)).toEqual([".codex/config.toml", ".codex/hooks.json", ".codex/rules", ".codex/skills"])
  })

  // Codex takes a CODEX_HOME that is set as the canonical path of the value
  // as written (find_codex_home at rust-v0.156.1): a `..` after a link steps
  // up from the link's target, not from the link. A home spelled that way
  // that only reads as the repository's folder is not Codex's home.
  it("reads a .codex folder a set CODEX_HOME only spells, through a link and `..`", async () => {
    const root = await scratch()
    const elsewhere = await scratch("domovoi-provider-home-")
    await mkdir(join(elsewhere, ".codex"))
    await mkdir(join(elsewhere, "sub"))
    await symlink(join(elsewhere, "sub"), join(root, "link"), process.platform === "win32" ? "junction" : "dir")
    await put(root, ".codex/config.toml", "[mcp_servers.repository]\ncommand = \"repository-server\"\n")
    const codexHome = `${root}/link/../.codex`
    const codexServers = (result: { providers: ToolInventoryProvider[] }) => provider(result, "codex").entries.flatMap((entry) => (entry.kind === "tool-server" ? [entry.name] : []))
    const first = await readRepositoryProviderConfig(root, { heldBack: true, codexHome })
    expect(provider(first, "codex").files).toEqual([{ path: ".codex/config.toml", source: "project-settings", state: "read" }])
    expect(codexServers(first)).toEqual(["repository"])
    await put(root, ".codex/config.toml", "[mcp_servers.repository]\ncommand = \"repository-server-2\"\n")
    const changed = await readRepositoryProviderConfig(root, { heldBack: true, codexHome })
    expect(changed.configDigest).not.toBe(first.configDigest)
    // The same value from the environment.
    vi.stubEnv("CODEX_HOME", codexHome)
    try {
      expect(codexServers(await readRepositoryProviderConfig(root, { heldBack: true }))).toEqual(["repository"])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses trust for a nested .codex folder a set CODEX_HOME only spells", async () => {
    const root = await scratch()
    const elsewhere = await scratch("domovoi-provider-home-")
    await mkdir(join(elsewhere, ".codex"))
    await mkdir(join(elsewhere, "sub"))
    await put(root, "app/.codex/config.toml", "[mcp_servers.nested]\ncommand = \"nested-server\"\n")
    await symlink(join(elsewhere, "sub"), join(root, "app", "link"), process.platform === "win32" ? "junction" : "dir")
    const nested = await readRepositoryProviderConfig(root, { heldBack: true, sessionFolder: "app", codexHome: `${root}/app/link/../.codex` })
    expect(nested.trustRefusals).toEqual([{ provider: "codex", reason: "nested-config", path: "app/.codex" }])
  })

  // A hook whose command is adversarial input, and TOML a parser has taken
  // more than linear work on, near the file limit: read in work that grows
  // about linearly with the input, counted, not timed.
  it.each(adversarialCommands)("reads a config.toml hook with %s in near-linear work", async (_name, size, generate) => {
    const roots = await Promise.all([size, size * 4].map(async (count) => {
      const root = await scratch()
      await put(root, ".codex/config.toml", `[[hooks.Stop]]\nhooks = [{ type = "command", command = ${JSON.stringify(generate(count))} }]\n`)
      return root
    }))
    const { growth, results } = await workGrowth(
      () => readRepositoryProviderConfig(roots[0]!, { heldBack: true }),
      () => readRepositoryProviderConfig(roots[1]!, { heldBack: true }),
    )
    for (const result of results) {
      const codex = provider(result, "codex")
      expect(codex.omittedEntries).toBe(0)
      expect(codex.entries).toHaveLength(1)
    }
    expect(growth).toBeLessThan(nearLinearGrowth)
  })

  it.each(adversarialTomlFiles)("reads a config.toml with %s in near-linear work", async (_name, size, generate) => {
    const roots = await Promise.all([size, size * 4].map(async (count) => {
      const root = await scratch()
      await put(root, ".codex/config.toml", generate(count))
      return root
    }))
    const { growth, results } = await workGrowth(
      () => readRepositoryProviderConfig(roots[0]!, { heldBack: true }),
      () => readRepositoryProviderConfig(roots[1]!, { heldBack: true }),
      { characterReads: true },
    )
    for (const result of results) expect(provider(result, "codex").files).toEqual([{ path: ".codex/config.toml", source: "project-settings", state: "read" }])
    expect(growth).toBeLessThan(nearLinearGrowth)
  })

  // The parser scans its input one character at a time with charCodeAt, so
  // its own work is counted with every character read. Not timed: on Node 22
  // four times the nested arrays took 8 to 10 times as long while the parser
  // read 4.007 times the characters and built 4 times the arrays. The rest was
  // the young generation collector copying the parsed result (growth 3.9 to
  // 4.1 with a 64 MB semi-space), which a clock cannot tell from the parser.
  it.each(adversarialTomlFiles)("parses TOML with %s in near-linear work, every character read counted", async (_name, size, generate) => {
    const small = generate(size)
    const large = generate(size * 4)
    const { growth } = await workGrowth(() => parseRepositoryToml(small), () => parseRepositoryToml(large), { characterReads: true })
    expect(growth).toBeLessThan(nearLinearGrowth)
  })

  // A positive control: a parser that reads the document again from its start
  // at every line, one character at a time, fails the same check.
  it("counts a character scan that starts again at every line as more than near-linear", async () => {
    const rescanning = (text: string) => {
      let reads = 0
      for (let line = text.indexOf("\n"); line !== -1; line = text.indexOf("\n", line + 1)) {
        for (let at = 0; at < line; at += 1) reads += text.charCodeAt(at) > 0 ? 1 : 0
      }
      return reads
    }
    const [, size, generate] = adversarialTomlFiles.find(([name]) => name === "table headers")!
    const small = generate(size / 4)
    const large = generate(size)
    const { growth } = await workGrowth(() => rescanning(small), () => rescanning(large), { characterReads: true })
    expect(growth).toBeGreaterThanOrEqual(nearLinearGrowth)
  })
})

// A main checkout and a linked worktree of it, laid out as git lays them out.
async function linkedWorktree(mainName?: string): Promise<{ main: string; worktree: string; gitDirectory: string }> {
  const main = mainName === undefined ? await scratch("domovoi-provider-main-") : join(await scratch("domovoi-provider-main-"), mainName)
  const worktree = await scratch("domovoi-provider-worktree-")
  const gitDirectory = join(main, ".git", "worktrees", "session")
  await put(main, ".git/HEAD", "ref: refs/heads/main\n")
  await put(main, ".git/worktrees/session/HEAD", "ref: refs/heads/session\n")
  await put(main, ".git/worktrees/session/gitdir", `${join(worktree, ".git")}\n`)
  await put(main, ".git/worktrees/session/commondir", "../..\n")
  await put(worktree, ".git", `gitdir: ${gitDirectory}\n`)
  return { main, worktree, gitDirectory }
}

// Trust covers the root .codex folder only (ruling Q113, Refs #656): Codex
// input anywhere else it would read keeps the repository untrusted, named by
// a reason code.
describe("readRepositoryProviderConfig: Codex input outside the root folder", () => {
  const read = (root: string, options: { sessionFolder?: string; codexHome?: string } = {}) => (
    readRepositoryProviderConfig(root, { heldBack: true, ...options })
  )
  const refusals = async (root: string, options: { sessionFolder?: string; codexHome?: string } = {}) => (await read(root, options)).trustRefusals

  it("refuses trust while a linked worktree's main checkout holds Codex hooks", async () => {
    const { main, worktree } = await linkedWorktree()
    const clear = await read(worktree)
    expect(clear.trustRefusals).toEqual([])
    await put(main, ".codex/config.toml", "sandbox_mode = \"read-only\"\n")
    expect(await refusals(worktree)).toEqual([])

    await put(main, ".codex/config.toml", "[[hooks.Stop]]\nhooks = [{ type = \"command\", command = \"main-hook\" }]\n")
    const hooked = await read(worktree)
    expect(hooked.trustRefusals).toEqual([{ provider: "codex", reason: "main-checkout-hooks", path: join(main, ".codex", "config.toml") }])
    expect(JSON.stringify(hooked)).not.toContain("main-hook")
    expect(hooked.configDigest).not.toBe(clear.configDigest)
    // A file the reader cannot read is refused as holding hooks.
    await put(main, ".codex/config.toml", "[hooks\n")
    expect(await refusals(worktree)).toEqual([{ provider: "codex", reason: "main-checkout-hooks", path: join(main, ".codex", "config.toml") }])
    await rm(join(main, ".codex", "config.toml"))
    await put(main, ".codex/hooks.json", "{}")
    expect(await refusals(worktree)).toEqual([{ provider: "codex", reason: "main-checkout-hooks", path: join(main, ".codex", "hooks.json") }])
    await rm(join(main, ".codex"), { recursive: true })

    // The main checkout's folder for each directory on the session's way down.
    await put(main, "sub/.codex/hooks.json", "{}")
    expect(await refusals(worktree)).toEqual([])
    await mkdir(join(worktree, "sub"))
    expect(await refusals(worktree, { sessionFolder: "sub" })).toEqual([
      { provider: "codex", reason: "main-checkout-hooks", path: join(main, "sub", ".codex", "hooks.json") },
    ])
    // The main checkout itself, and a checkout with no linked worktree.
    expect(await refusals(main)).toEqual([])
  })

  it("refuses trust when a link or a mismatch is on the way to the main checkout", async () => {
    const dir = process.platform === "win32" ? "junction" : "dir"
    const unknown = [{ provider: "codex", reason: "main-checkout-unknown", path: ".git" }]

    const linkedFile = await linkedWorktree()
    await rm(join(linkedFile.worktree, ".git"))
    await put(linkedFile.main, "git-file", `gitdir: ${linkedFile.gitDirectory}\n`)
    await symlink(join(linkedFile.main, "git-file"), join(linkedFile.worktree, ".git"))
    expect(await refusals(linkedFile.worktree)).toEqual(unknown)

    const linkedDirectory = await linkedWorktree()
    const alias = join(linkedDirectory.main, "alias")
    await symlink(linkedDirectory.gitDirectory, alias, dir)
    await put(linkedDirectory.worktree, ".git", `gitdir: ${alias}\n`)
    expect(await refusals(linkedDirectory.worktree)).toEqual(unknown)

    const linkedBacklink = await linkedWorktree()
    await rm(join(linkedBacklink.gitDirectory, "commondir"))
    await put(linkedBacklink.main, "commondir-target", "../..\n")
    await symlink(join(linkedBacklink.main, "commondir-target"), join(linkedBacklink.gitDirectory, "commondir"))
    expect(await refusals(linkedBacklink.worktree)).toEqual(unknown)

    const mismatched = await linkedWorktree()
    await put(mismatched.main, ".git/worktrees/session/gitdir", `${join(mismatched.main, "other", ".git")}\n`)
    expect(await refusals(mismatched.worktree)).toEqual(unknown)

    const missing = await linkedWorktree()
    await rm(join(missing.gitDirectory, "commondir"))
    expect(await refusals(missing.worktree)).toEqual(unknown)

    const linkedFolder = await linkedWorktree()
    const outside = await scratch("domovoi-provider-outside-")
    await put(outside, "codex/config.toml", "sandbox_mode = \"read-only\"\n")
    await symlink(join(outside, "codex"), join(linkedFolder.main, ".codex"), dir)
    expect(await refusals(linkedFolder.worktree)).toEqual([{ provider: "codex", reason: "main-checkout-hooks", path: join(linkedFolder.main, ".codex") }])

    // A submodule's .git file names no linked worktree: Codex takes no hooks
    // from elsewhere.
    const submodule = await scratch()
    const parent = await scratch("domovoi-provider-parent-")
    await put(parent, ".git/modules/sub/HEAD", "ref: refs/heads/main\n")
    await put(submodule, ".git", `gitdir: ${join(parent, ".git", "modules", "sub")}\n`)
    await put(parent, ".codex/hooks.json", "{}")
    expect(await refusals(submodule)).toEqual([])
  })

  // Codex trims only ASCII whitespace from git's metadata files ([u8]::trim_ascii
  // in resolve_root_git_project_for_trust at rust-v0.156.1), and git keeps
  // the rest of the line: a no-break space (U+00A0) starts a file name.
  it("finds the main checkout a .git file names after a no-break space", async () => {
    const worktree = await scratch("domovoi-provider-worktree-")
    const nbsp = " "
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" })
    // The checkout Codex and git find, and the one a Unicode trim finds.
    const actual = join(worktree, `${nbsp}main`)
    const decoy = join(worktree, "main")
    for (const main of [actual, decoy]) {
      await mkdir(main)
      git(main, "init", "-q")
      await put(main, ".git/worktrees/session/HEAD", "ref: refs/heads/session\n")
      await put(main, ".git/worktrees/session/gitdir", `${join(worktree, ".git")}\n`)
      await put(main, ".git/worktrees/session/commondir", "../..\n")
    }
    await put(worktree, ".git", `gitdir: ${nbsp}main/.git/worktrees/session\n`)
    await put(worktree, ".codex/config.toml", "sandbox_mode = \"read-only\"\n")
    await put(actual, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "main-hook" }] }] } }))
    const commonDirectory = git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()
    expect(await realpath(commonDirectory)).toBe(await realpath(join(actual, ".git")))
    expect(await refusals(worktree)).toEqual([{ provider: "codex", reason: "main-checkout-hooks", path: join(actual, ".codex", "hooks.json") }])
  })

  it("finds the main checkout of a worktree git made", async () => {
    const base = await scratch("domovoi-provider-git-")
    const main = join(base, "main")
    const worktree = join(base, "worktree")
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Domovoi Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" })
    await mkdir(main)
    git(main, "init", "-q")
    git(main, "commit", "-q", "--allow-empty", "-m", "init")
    git(main, "worktree", "add", "-q", worktree)
    expect(await refusals(worktree)).toEqual([])
    await put(main, ".codex/hooks.json", "{}")
    expect(await refusals(worktree)).toEqual([{ provider: "codex", reason: "main-checkout-hooks", path: join(main, ".codex", "hooks.json") }])
  })

  // Codex reads a .codex folder and .agents/skills in each directory from the
  // session's down to the root. Domovoi starts Codex at a worktree's root, so
  // nothing below the root is read unless a deeper session folder is named.
  it("refuses trust while Codex input sits below the root on the session's way down", async () => {
    const root = await scratch()
    await put(root, "packages/app/.codex/config.toml", "[mcp_servers.x]\ncommand = \"nested-server\"\n")
    await put(root, "packages/.agents/skills/s/SKILL.md", "s")
    await put(root, "tools/.codex/hooks.json", "{}")
    const atRoot = await read(root)
    expect(atRoot.trustRefusals).toEqual([])
    expect(JSON.stringify(atRoot)).not.toContain("nested-server")
    expect(atRoot.configDigest).toBe((await read(await scratch())).configDigest)

    const nested = await read(root, { sessionFolder: "packages/app" })
    expect(nested.trustRefusals).toEqual([
      { provider: "codex", reason: "nested-config", path: "packages/.agents/skills" },
      { provider: "codex", reason: "nested-config", path: "packages/app/.codex" },
    ])
    expect(JSON.stringify(nested)).not.toContain("nested-server")
    expect(await refusals(root, { sessionFolder: "docs/site" })).toEqual([])
    // A folder that is Codex's own home is the person's, and skipped.
    expect(await refusals(root, { sessionFolder: "packages/app", codexHome: join(root, "packages", "app", ".codex") })).toEqual([
      { provider: "codex", reason: "nested-config", path: "packages/.agents/skills" },
    ])
    // A link on the way down is refused, not followed.
    await symlink(join(root, "packages"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    expect(await refusals(root, { sessionFolder: "linked/app" })).toEqual([{ provider: "codex", reason: "nested-config", path: "linked" }])
    for (const sessionFolder of ["../elsewhere", "/abs", "a//b", "a/./b", ""]) {
      await expect(read(root, { sessionFolder })).rejects.toThrow(/session folder/u)
    }
  })

  // Folder names come from the repository and the machine, so a refusal's
  // path is shown redacted, as every listed path is.
  it("shows the path of a refused folder redacted", async () => {
    const canary = "REVIEW_PATH_CANARY"
    const { main, worktree } = await linkedWorktree(`main TOKEN=${canary}`)
    await put(main, ".codex/hooks.json", "{}")
    const hooked = await read(worktree)
    expect(hooked.trustRefusals).toEqual([{ provider: "codex", reason: "main-checkout-hooks", path: `${join(dirname(main), "main")} [REDACTED]` }])
    expect(JSON.stringify(hooked)).not.toContain(canary)

    const root = await scratch()
    await put(root, `app TOKEN=${canary}/.codex/config.toml`, "sandbox_mode = \"read-only\"\n")
    const nested = await read(root, { sessionFolder: `app TOKEN=${canary}` })
    expect(nested.trustRefusals).toEqual([{ provider: "codex", reason: "nested-config", path: "app [REDACTED]" }])
    expect(JSON.stringify(nested)).not.toContain(canary)
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
      "curl [REDACTED]",
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
      "curl [REDACTED]",
      "curl [REDACTED]",
    ])
  })

  it("lists hooks whose scheme and flag words chain, every value redacted", async () => {
    const root = await scratch()
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [
        { type: "command", command: "curl Bearer --token Token s3cr3t-value" },
        { type: "command", command: "curl Bearer Basic hunter2" },
        { type: "command", command: "curl", args: ["Bearer", "--token", "Token", "tok-abc"] },
        { type: "command", command: "curl", args: ["--token", "Bearer", "q-secret"] },
      ] }] },
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expectNoSecret(claude)
    expect(claude.omittedEntries).toBe(0)
    expect(claude.entries.map((entry) => (entry.kind === "hook" ? entry.command : undefined))).toEqual([
      "curl [REDACTED]",
      "curl [REDACTED]",
      "curl [REDACTED]",
      "curl [REDACTED]",
    ])
  })

  it("lists the hooks of the review's examples, the value after a word another rule took redacted", async () => {
    const root = await scratch()
    const hooks = ["curl --token 'https://host/ Token' s3cr3t-value", "curl --token 'x -H X-Foo: Bearer ' s3cr3t-value"].flatMap((command) => {
      const argv = inventoryShellWords(command)!
      return [{ type: "command", command }, { type: "command", command: argv[0], args: argv.slice(1) }, { type: "prompt", prompt: command }]
    })
    await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks }] } }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expectNoSecret(claude)
    expect(claude.omittedEntries).toBe(0)
    expect(claude.entries.map((entry) => (entry.kind === "hook" ? entry.command : undefined))).toEqual([
      "curl [REDACTED]",
      "curl [REDACTED]",
      "curl [REDACTED]",
      "curl [REDACTED]",
      "curl [REDACTED]",
      "curl [REDACTED]",
    ])
  })

  // Every scheme word and sensitive flag at the end of each kind of value
  // another rule takes, with a credential after it, as a command, a command
  // and its arguments, and a prompt: every hook is listed, none refused.
  it.each(hiddenTriggerPlacements)("lists every hook with a scheme word or sensitive flag at the end of %s", async (_kind, place) => {
    const root = await scratch()
    const hooks = hiddenTriggerWords.flatMap((word) => {
      const { text, argv } = place(word)
      return [{ type: "command", command: text }, { type: "command", command: argv[0], args: argv.slice(1) }, { type: "prompt", prompt: text }]
    })
    await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks }] } }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(JSON.stringify(claude)).not.toContain(hiddenTriggerCredential)
    expect(claude.omittedEntries).toBe(0)
    expect(claude.entries.filter((entry) => entry.kind === "hook")).toHaveLength(hooks.length)
  })

  // A scheme word or sensitive flag with its credential in the same URL word,
  // which the URL rule took whole: the credential is hidden, and every hook is
  // listed, the one the protocol would take for prose and the one it would
  // refuse.
  it("lists the hooks of a credential in a URL's authority, the credential redacted", async () => {
    const root = await scratch()
    await put(root, ".claude/settings.json", JSON.stringify({
      hooks: { Stop: [{ hooks: [
        { type: "command", command: "curl 'https://host Token swordfish tail'" },
        { type: "command", command: "curl", args: ["https://host Token swordfish tail"] },
        { type: "prompt", prompt: "curl 'https://host Token swordfish tail'" },
      ] }] },
    }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(JSON.stringify(claude)).not.toContain("swordfish")
    expect(claude.omittedEntries).toBe(0)
    // The arguments are cut at the whole argument that holds the scheme word.
    expect(claude.entries.map((entry) => (entry.kind === "hook" ? entry.command : undefined))).toEqual([
      "curl 'https://host [REDACTED]'",
      "curl [REDACTED]",
      "curl 'https://host [REDACTED]'",
    ])
  })

  it("keeps the hooks of a refused credential in a URL's authority listed", async () => {
    const root = await scratch()
    const hooks = ["curl 'https://host Token x'", "curl 'https://host --token swordfish'"].flatMap((command) => {
      const argv = inventoryShellWords(command)!
      return [{ type: "command", command }, { type: "command", command: argv[0], args: argv.slice(1) }, { type: "prompt", prompt: command }]
    })
    await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks }] } }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(JSON.stringify(claude)).not.toContain("swordfish")
    expect(claude.omittedEntries).toBe(0)
    // A command and a prompt are cut in the word; the arguments at the whole argument.
    expect(claude.entries.map((entry) => (entry.kind === "hook" ? entry.command : undefined))).toEqual(
      [1, 2].flatMap(() => ["curl 'https://host [REDACTED]'", "curl [REDACTED]", "curl 'https://host [REDACTED]'"]),
    )
  })

  // Every trigger inside every place one word can hold it, its credential in
  // the same word, as a command, a command and its arguments, and a prompt,
  // as written and wrapped in shells and env: every hook is listed.
  it.each(sameWordPlacements.flatMap(([kind, place]) => sameWordWrappers.map(([wrapping, wrap]) => [kind, wrapping, sameWordCases(place, wrap)] as const)))(
    "lists every hook with a credential in the same word as its trigger in %s %s",
    async (_kind, _wrapping, cases) => {
      const root = await scratch()
      const hooks = cases.flatMap(({ text, argv }) => [
        { type: "command", command: text }, { type: "command", command: argv[0], args: argv.slice(1) }, { type: "prompt", prompt: text },
      ])
      await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks }] } }))
      const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
      expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
      for (const secret of sameWordCredentials) expect(JSON.stringify(claude)).not.toContain(secret)
      expect(claude.omittedEntries).toBe(0)
      expect(claude.entries.filter((entry) => entry.kind === "hook")).toHaveLength(hooks.length)
    },
  )

  // A trigger the protocol backstop reads in another view than the one written
  // (percent-decoded, unescaped, a JSON argv's strings, a value after an
  // opening quote), or a sensitive key with an escaped blank before its value,
  // as a command, a command and its arguments, a prompt and a shell's script
  // in arguments: every hook is listed, its credential hidden.
  const viewHooks = (text: string, argv: readonly string[]) => [
    { type: "command", command: text }, { type: "command", command: argv[0], args: argv.slice(1) }, { type: "prompt", prompt: text },
    { type: "command", command: "sh", args: ["-c", text] },
  ]
  const expectViewHooksListed = async (cases: ReadonlyArray<{ text: string; argv: readonly string[] }>) => {
    // Each file stays under the reader's cap on entries.
    for (let from = 0; from < cases.length; from += 100) {
      const root = await scratch()
      const hooks = cases.slice(from, from + 100).flatMap(({ text, argv }) => viewHooks(text, argv))
      await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks }] } }))
      const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
      expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
      expect(JSON.stringify(claude)).not.toContain(viewCredential)
      expect(claude.omittedEntries).toBe(0)
      expect(claude.entries.filter((entry) => entry.kind === "hook")).toHaveLength(hooks.length)
    }
  }

  it.each([...viewTexts, ...escapedBlankTexts])("lists the hooks of %s, the credential redacted", async (text) => {
    await expectViewHooksListed([{ text, argv: inventoryShellWords(text)! }])
  })

  it.each(viewPlacements.flatMap(([placement, place]) => viewSpellings.flatMap(([spelling, spell]) => sameWordWrappers.map(([wrapping, wrap]) => (
    [placement, spelling, wrapping, viewCases(place, spell, wrap)] as const
  )))))("lists every hook with an encoded trigger in %s, %s, %s", async (_placement, _spelling, _wrapping, cases) => {
    await expectViewHooksListed(cases)
  })

  // A scheme word and its value in double-quoted strings of their own, and an
  // ordinary header after a percent-encoded header flag, as a command, a
  // command and its arguments, a prompt, and the script of sh -c, bash -lc and
  // env MODE=x sh -c: every hook is listed, cut before its first trigger.
  it("lists every hook of a trigger only a quoted string or a decoding reads, cut before it", async () => {
    const root = await scratch()
    const hooks = quotedStringTexts.flatMap((text) => {
      const argv = inventoryShellWords(text)!
      return [
        { type: "command", command: text }, { type: "command", command: argv[0], args: argv.slice(1) }, { type: "prompt", prompt: text },
        { type: "command", command: "sh", args: ["-c", text] }, { type: "command", command: "bash", args: ["-lc", text] },
        { type: "command", command: "env", args: ["MODE=x", "sh", "-c", text] },
      ]
    })
    await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks }] } }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(JSON.stringify(claude)).not.toContain(viewCredential)
    expect(claude.omittedEntries).toBe(0)
    const commands = claude.entries.flatMap((entry) => (entry.kind === "hook" ? [entry.command] : []))
    expect(commands).toHaveLength(hooks.length)
    for (const command of commands) expect(command).toMatch(/\[REDACTED\]$/u)
  })

  // A trigger only the shell's words read two or three times join, after a
  // quote percent decoding makes, and text whose views do not settle, as a
  // command, a command and its arguments, a prompt, and the script of sh -c,
  // bash -lc, env MODE=x sh -c and env sh -c: every hook is listed, cut before
  // the trigger or after its program name.
  it("lists every hook of a trigger the shell's words read twice or more, cut before it", async () => {
    const root = await scratch()
    const texts = [...shellReadingTexts, ...generatedShellReadingTexts, ...unsettledViewTexts.map(([, text]) => text)]
    const hooks = texts.flatMap((text) => {
      const argv = inventoryShellWords(text)!
      return [
        { type: "command", command: text }, { type: "command", command: argv[0], args: argv.slice(1) }, { type: "prompt", prompt: text },
        { type: "command", command: "sh", args: ["-c", text] }, { type: "command", command: "bash", args: ["-lc", text] },
        { type: "command", command: "env", args: ["MODE=x", "sh", "-c", text] }, { type: "command", command: "env", args: ["sh", "-c", text] },
      ]
    })
    await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks }] } }))
    const claude = provider(await readRepositoryProviderConfig(root, { heldBack: true }), "claude-code")
    expect(toolInventoryProviderSchema.safeParse(claude).success).toBe(true)
    expect(JSON.stringify(claude).toLowerCase()).not.toContain(viewCredential)
    expect(claude.omittedEntries).toBe(0)
    const commands = claude.entries.flatMap((entry) => (entry.kind === "hook" ? [entry.command] : []))
    expect(commands).toHaveLength(hooks.length)
    for (const command of commands) expect(command).toMatch(/\[REDACTED\]['"]*$/u)
  })

  // A hook whose command is adversarial input near the file limit is read in
  // work that grows about linearly with it: counted, not timed.
  it.each(adversarialCommands)("reads a hook with %s in near-linear work", async (_name, size, generate) => {
    const roots = await Promise.all([size, size * 4].map(async (count) => {
      const root = await scratch()
      await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: generate(count) }] }] } }))
      return root
    }))
    const { growth, results } = await workGrowth(
      () => readRepositoryProviderConfig(roots[0]!, { heldBack: true }),
      () => readRepositoryProviderConfig(roots[1]!, { heldBack: true }),
    )
    for (const result of results) {
      const claude = provider(result, "claude-code")
      expect(claude.omittedEntries).toBe(0)
      expect(claude.entries).toHaveLength(1)
    }
    expect(growth).toBeLessThan(nearLinearGrowth)
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
