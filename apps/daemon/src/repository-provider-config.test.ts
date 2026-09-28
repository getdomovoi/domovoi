import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"

import { toolInventoryProviderSchema, toolInventorySchema, type ToolInventoryProvider } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { inventoryShellWords } from "./inventory-redaction.js"
import { maximumRepositoryConfigFileBytes, readRepositoryProviderConfig } from "./repository-provider-config.js"
import { maximumRepositoryTomlDepth, parseRepositoryToml } from "./repository-toml.js"
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
    ]
    await put(root, ".codex/config.toml", helpers.map(([name, helper]) => (
      `[mcp_servers.${name}]\nurl = "https://mcp.example.test"\nhttp_headers_helper = ${JSON.stringify(helper)}\n`
    )).join("\n"))
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
