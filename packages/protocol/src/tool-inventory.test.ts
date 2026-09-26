import { describe, expect, it } from "vitest"

import {
  approvalRequestSchema,
  executionResolutionSchema,
  phoneAndTabletRpcMethods,
  rpcMethodAuthorizations,
  rpcMethodMutations,
  rpcMethods,
  toolInventorySchema,
} from "./index.js"

const digest = `sha256:${"a".repeat(64)}`
const home = "/Users/ada"

// The J45 Tools tab sample from the Skills design (2026-09-23), with the local
// settings file unreadable and a provider that passes no tool servers.
const sample = {
  machine: { id: "machine-studio", name: "studio", platform: "darwin", arch: "arm64", version: "0.9.4" },
  repository: { projectId: "project-acme", root: "/Users/ada/src/acme-api", configDigest: digest },
  providers: [
    {
      provider: "claude-code",
      toolServers: "read-from-files",
      files: [
        { path: ".mcp.json", source: "repository-file", state: "read" },
        { path: ".claude/settings.json", source: "project-settings", state: "read" },
        { path: ".claude/settings.local.json", source: "local-settings", state: "unreadable", reason: "EACCES · owned by root, mode 0600" },
        { path: `${home}/.claude.json`, source: "user-settings", state: "read" },
        { path: `${home}/.claude/settings.json`, source: "user-settings", state: "read" },
      ],
      entries: [
        { kind: "tool-server", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: ["DATABASE_URL"], file: ".mcp.json", startsAtSessionStart: true, heldBack: true },
        { kind: "tool-server", name: "linear", transport: "http", host: "mcp.linear.app", envKeys: [], file: ".mcp.json", startsAtSessionStart: true, heldBack: true },
        { kind: "hook", event: "SessionStart", command: "./scripts/dev-bootstrap.sh", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
        { kind: "hook", event: "PreToolUse", matcher: "Bash", command: "./scripts/guard-prod.sh", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
        { kind: "permission-rule", rule: "allow", detail: "Bash(pnpm test:*)", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
        { kind: "permission-rule", rule: "deny", detail: "Read(./.env*)", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
        { kind: "env-key", key: "NODE_ENV", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
        { kind: "tool-server", name: "github", transport: "stdio", command: "gh-mcp serve", envKeys: ["GITHUB_TOKEN"], file: `${home}/.claude.json`, startsAtSessionStart: false, heldBack: false },
        { kind: "hook", event: "Stop", command: "afplay /System/Library/Sounds/Glass.aiff", file: `${home}/.claude/settings.json`, startsAtSessionStart: false, heldBack: false },
        { kind: "permission-rule", rule: "allow", detail: "WebFetch(domain:docs.stripe.com)", file: `${home}/.claude/settings.json`, startsAtSessionStart: false, heldBack: false },
        { kind: "helper", name: "apiKeyHelper", command: "~/bin/key.sh", file: `${home}/.claude/settings.json`, startsAtSessionStart: true, heldBack: false },
      ],
    },
    {
      provider: "codex",
      toolServers: "read-from-files",
      files: [
        { path: ".codex/config.toml", source: "project-settings", state: "absent" },
        { path: `${home}/.codex/config.toml`, source: "user-settings", state: "read" },
      ],
      entries: [
        { kind: "permission-rule", rule: "approval_policy", detail: "on-request", file: `${home}/.codex/config.toml`, startsAtSessionStart: false, heldBack: false },
        { kind: "permission-rule", rule: "sandbox_mode", detail: "workspace-write", file: `${home}/.codex/config.toml`, startsAtSessionStart: false, heldBack: false },
      ],
    },
    { provider: "acp-gemini", toolServers: "none-passed", files: [], entries: [] },
  ],
} as const

type Sample = typeof sample
const claude = (edit: (provider: Record<string, unknown> & { entries: unknown[], files: unknown[] }) => void): unknown => {
  const copy = structuredClone(sample) as unknown as { providers: (Record<string, unknown> & { entries: unknown[], files: unknown[] })[] }
  edit(copy.providers[0]!)
  return copy
}
const withEntry = (entry: object) => claude((provider) => { provider.entries = [{ file: ".mcp.json", startsAtSessionStart: false, heldBack: true, ...entry }] })
const server: Sample["providers"][0]["entries"][0] = sample.providers[0].entries[0]

describe("tool inventory", () => {
  it("parses the design's sample unchanged", () => {
    expect(toolInventorySchema.parse(sample)).toEqual(sample)
  })

  it("carries environment key names and never their values", () => {
    expect(toolInventorySchema.safeParse(withEntry({ kind: "env-key", key: "DATABASE_URL" })).success).toBe(true)
    expect(toolInventorySchema.safeParse(withEntry(server)).success).toBe(true)
    expect(toolInventorySchema.safeParse(withEntry({ kind: "env-key", key: "DATABASE_URL", value: "postgres://u:p@db" })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, env: { DATABASE_URL: "postgres://u:p@db" } })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ kind: "env-key", key: "DATABASE_URL=postgres://u:p@db" })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, envKeys: ["TOKEN=abc"] })).success).toBe(false)
  })

  it("names a remote server by host, without a path, query or credentials", () => {
    const remote = sample.providers[0].entries[1]
    expect(toolInventorySchema.safeParse(withEntry({ ...remote, host: "mcp.linear.app:8443" })).success).toBe(true)
    for (const host of ["mcp.linear.app/mcp", "user:token@mcp.linear.app", "mcp.linear.app?key=1", "https://mcp.linear.app"]) {
      expect(toolInventorySchema.safeParse(withEntry({ ...remote, host })).success, host).toBe(false)
    }
    const { host: _, ...noHost } = remote
    expect(toolInventorySchema.safeParse(withEntry({ ...noHost, command: "npx mcp-remote" })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, host: "db.internal" })).success).toBe(false)
  })

  it("rejects extra fields everywhere", () => {
    expect(toolInventorySchema.safeParse({ ...sample, extra: true }).success).toBe(false)
    expect(toolInventorySchema.safeParse(claude((provider) => { provider.extra = true })).success).toBe(false)
    expect(toolInventorySchema.safeParse(claude((provider) => { (provider.files[0] as object as Record<string, unknown>).reason = "x" })).success).toBe(false)
    expect(toolInventorySchema.safeParse(claude((provider) => { delete (provider.files[2] as Record<string, unknown>).reason })).success).toBe(false)
  })

  it("lists entries only from files it read, and holds back only repository entries", () => {
    expect(toolInventorySchema.safeParse(withEntry({ ...server, file: `${home}/.claude.json`, heldBack: false })).success).toBe(true)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, file: ".claude/settings.local.json" })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, file: "never-listed.json" })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, file: `${home}/.claude.json`, heldBack: true })).success).toBe(false)
    // Repository entries need the digest a trust decision pins to.
    const { repository: _, ...withoutRepository } = sample
    expect(toolInventorySchema.safeParse(withoutRepository).success).toBe(false)
  })

  it("says none passed rather than listing tool servers for such a provider", () => {
    const copy = structuredClone(sample) as unknown as { providers: { toolServers: string }[] }
    copy.providers[0]!.toolServers = "none-passed"
    expect(toolInventorySchema.safeParse(copy).success).toBe(false)
  })

  it("holds its caps", () => {
    const many = <T>(item: T, count: number) => Array.from({ length: count }, () => item)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, name: "x".repeat(257) })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, command: "x".repeat(2_049) })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, envKeys: many("KEY", 65) })).success).toBe(false)
    expect(toolInventorySchema.safeParse(claude((provider) => { provider.entries = many(server, 513) })).success).toBe(false)
    expect(toolInventorySchema.safeParse(claude((provider) => { (provider.files[2] as Record<string, unknown>).reason = "x".repeat(257) })).success).toBe(false)
    expect(toolInventorySchema.safeParse(withEntry({ ...server, name: "line\nbreak" })).success).toBe(false)
    expect(toolInventorySchema.safeParse({ ...sample, repository: { ...sample.repository, configDigest: "sha256:abc" } }).success).toBe(false)
  })

  it("is an observe, read-only method the phone does not get", () => {
    expect(rpcMethods["tool.inventory"].params.safeParse({}).success).toBe(true)
    expect(rpcMethods["tool.inventory"].params.safeParse({ projectId: "x" }).success).toBe(false)
    expect(rpcMethods["tool.inventory"].result).toBe(toolInventorySchema)
    expect(rpcMethodAuthorizations["tool.inventory"]).toBe("observe")
    expect(rpcMethodMutations["tool.inventory"]).toBe("read-only")
    expect(phoneAndTabletRpcMethods.has("tool.inventory")).toBe(false)
  })
})

describe("approval tool server fact", () => {
  const approval = {
    id: "approval-tool",
    sessionId: "session-test",
    risk: "normal",
    operation: "Call tool",
    command: "postgres-dev.run_query",
    machine: "studio",
    agent: "claude-code",
    mode: "build",
    directory: "/worktrees/session-test",
    affects: "dev database acme_dev",
    network: "None",
    estimatedDuration: "Unknown",
    checkpoint: "abc123",
    requestedAt: "2026-09-26T10:00:00.000Z",
    execution: { state: "unresolved", reason: "unsupported-syntax" },
    revision: 0,
    toolServer: { name: "postgres-dev", transport: "stdio", source: "repository-file", file: ".mcp.json" },
  } as const

  it("round-trips the server and the file that declared it", () => {
    expect(approvalRequestSchema.parse(approval)).toEqual(approval)
  })

  it("rejects extra fields and values it does not know", () => {
    expect(approvalRequestSchema.safeParse({ ...approval, toolServer: { ...approval.toolServer, env: { TOKEN: "x" } } }).success).toBe(false)
    expect(approvalRequestSchema.safeParse({ ...approval, toolServer: { ...approval.toolServer, transport: "carrier-pigeon" } }).success).toBe(false)
    expect(approvalRequestSchema.safeParse({ ...approval, toolServer: { ...approval.toolServer, name: "" } }).success).toBe(false)
  })

  it("never pairs a tool server call with a resolved record, so no Always rule can stand", () => {
    const resolved = {
      state: "resolved",
      record: {
        version: 1,
        coverage: "command-and-script-text",
        cwd: ".",
        kind: "shell",
        entries: [{ id: 0, source: { kind: "request" }, parts: [{ operator: null, argv: ["psql"], expandsTo: [] }] }],
      },
      digest: `sha256:${"b".repeat(64)}`,
    }
    expect(executionResolutionSchema.safeParse(resolved).success).toBe(true)
    expect(approvalRequestSchema.safeParse({ ...approval, execution: resolved }).success).toBe(false)
  })
})
