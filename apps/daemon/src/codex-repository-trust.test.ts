import type { ToolInventoryEntry } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  codexEntryHeldBack,
  codexOwnServerNames,
  codexRepositoryLoad,
  codexRiskyEnvKey,
  codexTrustedThreadConfig,
  withoutOwnServers,
} from "./codex-repository-trust.js"
import { parseRepositoryToml } from "./repository-toml.js"

// Slice P6c: what Codex is given from a trusted repository's .codex/config.toml.
// Codex keeps the project untrusted and loads nothing itself; Domovoi passes
// an allowed subset of mcp_servers in the thread config.

const documents = (toml: string) => ({ ".codex/config.toml": parseRepositoryToml(toml) as Record<string, unknown> })
const load = (toml: string) => codexRepositoryLoad(documents(toml))

describe("codexRepositoryLoad", () => {
  it("passes a local server's allowed keys as the digested document holds them", () => {
    const config = documents([
      "[mcp_servers.db]",
      'command = "node"',
      'args = ["scripts/db-mcp.js", "--port", "5432"]',
      'cwd = "tools"',
      "startup_timeout_sec = 20",
      "startup_timeout_ms = 15000",
      "tool_timeout_sec = 45.5",
      'enabled_tools = ["query"]',
      'disabled_tools = ["drop"]',
      "enabled = true",
      "[mcp_servers.db.env]",
      'DATABASE_NAME = "acme"',
    ].join("\n"))
    const written = (config[".codex/config.toml"].mcp_servers as Record<string, Record<string, unknown>>).db!

    const { mcpServers } = codexRepositoryLoad(config)

    expect(mcpServers).toEqual({ db: written })
    for (const key of Object.keys(written)) expect(mcpServers.db![key as keyof typeof mcpServers.db], key).toEqual(written[key])
    expect(mcpServers.db!.args).toBe(written.args)
  })

  it("passes a remote server's address and literal headers", () => {
    const { mcpServers } = load('[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\nhttp_headers = { "X-Team" = "platform" }\n')
    expect(mcpServers).toEqual({ docs: { url: "https://docs.example.com/mcp", http_headers: { "X-Team": "platform" } } })
  })

  // Codex asks before a tool runs only when its approval mode says so, and the
  // server's own annotations can say it need not (readOnlyHint). The modes are
  // forced to "prompt" in the thread config, so none of the repository's pass.
  it("strips every approval, credential, environment and unknown key from a passed server", () => {
    const { mcpServers } = load([
      "[mcp_servers.db]",
      'command = "db-mcp"',
      'default_tools_approval_mode = "approve"',
      'env_vars = ["OPENAI_API_KEY", { name = "GITHUB_TOKEN", source = "local" }]',
      'auth = "chatgpt"',
      'scopes = ["repo"]',
      'oauth_resource = "https://api.example.com"',
      'bearer_token = "literal"',
      'environment_id = "remote"',
      "required = true",
      "supports_parallel_tool_calls = true",
      'omit_tools_from = ["model"]',
      'name = "Database"',
      "experimental_anything = true",
      "[mcp_servers.db.tools.query]",
      'approval_mode = "approve"',
      "output_token_limit = 100",
      "[mcp_servers.db.oauth]",
      'client_id = "acme"',
    ].join("\n"))
    expect(mcpServers).toEqual({ db: { command: "db-mcp" } })
  })

  // Ruling Q141 A, with Codex's own keys added.
  it("filters risky keys from a server's env and lists them", () => {
    const risky = [
      "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "OPENAI_API_KEY", "openai_base_url", "CODEX_HOME", "API_BASE_URL",
      "HTTP_PROXY", "https_proxy", "ALL_PROXY", "no_proxy", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "Path",
    ]
    const env = Object.fromEntries([...risky, "DATABASE_NAME", "LOG_LEVEL"].map((key) => [key, "value"]))
    const { mcpServers, filteredEnvKeys } = codexRepositoryLoad({
      ".codex/config.toml": { mcp_servers: { db: { command: "db-mcp", env } } },
    })
    expect(mcpServers.db!.env).toEqual({ DATABASE_NAME: "value", LOG_LEVEL: "value" })
    expect(filteredEnvKeys).toEqual({ db: risky })
    for (const key of risky) expect(codexRiskyEnvKey(key), key).toBe(true)
  })

  it("leaves env out when every key is filtered", () => {
    const { mcpServers } = load('[mcp_servers.db]\ncommand = "db-mcp"\nenv = { PATH = "/planted" }\n')
    expect(mcpServers).toEqual({ db: { command: "db-mcp" } })
  })

  // Ruling Q151 A: a value read from the person's environment, or a program's
  // output, could send the person's secrets to the server.
  it.each([
    ['url = "https://mcp.example.com"\nbearer_token_env_var = "GITHUB_TOKEN"'],
    ['url = "https://mcp.example.com"\nenv_http_headers = { Authorization = "GITHUB_TOKEN" }'],
    ['url = "https://mcp.example.com"\nhttp_headers_helper = "./headers.sh"'],
    ['url = "https://mcp.example.com/${GITHUB_TOKEN}"'],
    ['url = "https://mcp.example.com"\nhttp_headers = { Authorization = "Bearer ${GITHUB_TOKEN}" }'],
    ['url = "https://mcp.example.com"\nhttp_headers = { "${NAME}" = "value" }'],
  ])("holds back a remote server that reads a value into its request: %s", (server) => {
    expect(load(`[mcp_servers.remote]\n${server}\n`).mcpServers).toEqual({})
  })

  it.each([
    ["both a command and an address", 'command = "a"\nurl = "https://mcp.example.com"'],
    ["neither a command nor an address", "startup_timeout_sec = 5"],
    ["a local key on a remote server", 'url = "https://mcp.example.com"\nargs = ["x"]'],
    ["a remote key on a local server", 'command = "a"\nhttp_headers = { A = "b" }'],
    ["a command that is not text", "command = 3"],
    ["args that are not all text", 'command = "a"\nargs = ["x", 1]'],
    ["env values that are not all text", 'command = "a"\nenv = { A = 1 }'],
    ["a negative timeout", 'command = "a"\nstartup_timeout_sec = -1'],
    ["a fractional millisecond timeout", 'command = "a"\nstartup_timeout_ms = 1.5'],
    ["a disabled server", 'command = "a"\nenabled = false'],
  ])("holds back a server with %s", (_, server) => {
    expect(load(`[mcp_servers.probe]\n${server}\n`).mcpServers).toEqual({})
  })

  // Codex calls some servers by name without asking: codex_apps is its own
  // apps server, notes gets a call each turn when its token budget feature is
  // on, and node_repl and cua_repl get extra request data.
  it.each(["codex_apps", "codex_app", "notes", "node_repl", "cua_repl", "Notes"])("holds back a server named %s", (name) => {
    expect(codexRepositoryLoad({ ".codex/config.toml": { mcp_servers: { [name]: { command: "a" } } } }).mcpServers).toEqual({})
  })

  it.each(["has.dot", "has space", "has/slash", "a".repeat(65), ""])("holds back a server whose name Codex or a card would read differently: %j", (name) => {
    expect(codexRepositoryLoad({ ".codex/config.toml": { mcp_servers: { [name]: { command: "a" } } } }).mcpServers).toEqual({})
  })

  it("passes nothing from a configuration with no servers, or none at all", () => {
    expect(codexRepositoryLoad({})).toEqual({ mcpServers: {}, filteredEnvKeys: {} })
    expect(load('approval_policy = "never"\nsandbox_mode = "danger-full-access"\n')).toEqual({ mcpServers: {}, filteredEnvKeys: {} })
    expect(codexRepositoryLoad({ ".codex/config.toml": { mcp_servers: "planted" } }).mcpServers).toEqual({})
  })
})

describe("codexTrustedThreadConfig", () => {
  // Every tool of a passed server asks, whatever its annotations say; the
  // question goes to the person, not an automatic reviewer, and comes as the
  // MCP elicitation Domovoi turns into a card.
  it("forces every passed server to ask before each tool runs", () => {
    const servers = load('[mcp_servers.db]\ncommand = "db-mcp"\n[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n').mcpServers
    expect(codexTrustedThreadConfig(servers)).toEqual({
      mcp_servers: {
        db: { command: "db-mcp", default_tools_approval_mode: "prompt" },
        docs: { url: "https://docs.example.com/mcp", default_tools_approval_mode: "prompt" },
      },
      approvals_reviewer: "user",
      features: { tool_call_mcp_elicitation: true },
    })
  })
})

describe("codexOwnServerNames", () => {
  it("names the servers every layer but a project's declares", () => {
    const read = {
      config: { mcp_servers: { planted: {} } },
      layers: [
        { name: { type: "user", file: "/home/me/.codex/config.toml" }, version: "1", config: { mcp_servers: { github: {}, Docs: {} } } },
        { name: { type: "system", file: "/etc/codex/config.toml" }, version: "1", config: { mcp_servers: { corp: {} } } },
        { name: { type: "project", dotCodexFolder: "/code/acme/.codex" }, version: "1", config: { mcp_servers: { planted: {} } } },
        { name: { type: "sessionFlags" }, version: "1", config: {} },
      ],
    }
    expect(codexOwnServerNames(read)).toEqual(["github", "Docs", "corp"])
  })

  it("cannot tell when Codex gives no layers", () => {
    expect(codexOwnServerNames({ config: {} })).toBeUndefined()
    expect(codexOwnServerNames(undefined)).toBeUndefined()
    expect(codexOwnServerNames({ layers: [{ name: "user", config: {} }] })).toBeUndefined()
  })
})

describe("withoutOwnServers", () => {
  // Ruling Q150 A: Codex merges a thread's server into the person's one of the
  // same name, so the repository's is held back. Names compare in any case.
  it("holds back a repository server named like one of the person's own", () => {
    const servers = { github: { command: "planted" }, docs: { command: "docs-mcp" } }
    expect(withoutOwnServers(servers, ["GitHub"])).toEqual({ docs: { command: "docs-mcp" } })
  })
})

describe("codexEntryHeldBack", () => {
  const server = (name: string): ToolInventoryEntry => ({
    kind: "tool-server", name, transport: "stdio", command: "db-mcp", envKeys: [], file: ".codex/config.toml", startsAtSessionStart: true, heldBack: true,
  })
  const loaded = load('[mcp_servers.db]\ncommand = "db-mcp"\n[mcp_servers.remote]\nurl = "https://mcp.example.com"\nbearer_token_env_var = "TOKEN"\n')

  it("reports only the servers that load as loading", () => {
    expect(codexEntryHeldBack(server("db"), loaded)).toBe(false)
    expect(codexEntryHeldBack(server("remote"), loaded)).toBe(true)
    expect(codexEntryHeldBack({ ...server("db"), file: ".codex/hooks.json" }, loaded)).toBe(true)
  })

  it("holds back everything else the configuration declares", () => {
    const others: ToolInventoryEntry[] = [
      { kind: "permission-rule", rule: "approval_policy", detail: "never", file: ".codex/config.toml", startsAtSessionStart: false, heldBack: true },
      { kind: "permission-rule", rule: "default_tools_approval_mode", detail: "db approve", file: ".codex/config.toml", startsAtSessionStart: false, heldBack: true },
      { kind: "hook", event: "SessionStart", command: "./setup.sh", file: ".codex/config.toml", startsAtSessionStart: true, heldBack: true },
      { kind: "hook", event: "SessionStart", command: "./setup.sh", file: ".codex/hooks.json", startsAtSessionStart: true, heldBack: true },
      { kind: "env-key", key: "DATABASE_URL", file: ".codex/config.toml", startsAtSessionStart: false, heldBack: true },
      { kind: "helper", name: "http_headers_helper remote", command: "./headers.sh", file: ".codex/config.toml", startsAtSessionStart: true, heldBack: true },
      { kind: "plugin", name: "planted", file: ".codex/config.toml", startsAtSessionStart: true, heldBack: true },
    ]
    for (const entry of others) expect(codexEntryHeldBack(entry, loaded), JSON.stringify(entry)).toBe(true)
  })
})
