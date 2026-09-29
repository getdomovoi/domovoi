import { describe, expect, it, vi } from "vitest"

import { holdsCredential } from "./credential-backstop.js"

import {
  approvalRequestSchema,
  executionResolutionSchema,
  maximumToolInventoryBytes,
  maximumToolInventoryCommandLength,
  maximumToolInventoryDetailLength,
  maximumToolInventoryEventLength,
  maximumToolInventoryHelperNameLength,
  maximumToolInventoryMatcherLength,
  maximumToolInventoryNameLength,
  maximumToolInventoryRuleLength,
  phoneAndTabletRpcMethods,
  rpcMethodAuthorizations,
  rpcMethodMutations,
  rpcMethods,
  toolInventoryEntrySchema,
  toolInventorySchema,
} from "./index.js"

const digest = `sha256:${"a".repeat(64)}`
const home = "/Users/ada"

// The J45 Tools tab sample from the Skills design (2026-09-23), with the local
// settings file unreadable and a provider that passes no tool servers.
const sample = {
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
      omittedEntries: 0,
      files: [
        { path: ".codex/config.toml", source: "project-settings", state: "absent" },
        { path: `${home}/.codex/config.toml`, source: "user-settings", state: "read" },
      ],
      entries: [
        { kind: "permission-rule", rule: "approval_policy", detail: "on-request", file: `${home}/.codex/config.toml`, startsAtSessionStart: false, heldBack: false },
        { kind: "permission-rule", rule: "sandbox_mode", detail: "workspace-write", file: `${home}/.codex/config.toml`, startsAtSessionStart: false, heldBack: false },
      ],
    },
    { provider: "acp-gemini", toolServers: "none-passed", omittedEntries: 0, files: [], entries: [] },
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

  // The daemon's reader fits each text to these exported caps, so each must be
  // the cap the entry schema holds its fields to.
  it("holds each entry text field to its exported cap", () => {
    const base = { file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true }
    const fields: ReadonlyArray<[string, number, ReadonlyArray<(value: string) => unknown>]> = [
      ["command", maximumToolInventoryCommandLength, [
        (value) => ({ ...base, kind: "hook", event: "Stop", command: value }),
        (value) => ({ ...base, kind: "helper", name: "apiKeyHelper", command: value }),
        (value) => ({ ...base, kind: "tool-server", name: "s", transport: "stdio", command: value, envKeys: [] }),
      ]],
      ["detail", maximumToolInventoryDetailLength, [(value) => ({ ...base, kind: "permission-rule", rule: "allow", detail: value })]],
      ["matcher", maximumToolInventoryMatcherLength, [(value) => ({ ...base, kind: "hook", event: "Stop", matcher: value, command: "x" })]],
      ["name", maximumToolInventoryNameLength, [
        (value) => ({ ...base, kind: "tool-server", name: value, transport: "stdio", command: "x", envKeys: [] }),
        (value) => ({ ...base, kind: "plugin", name: value }),
        (value) => ({ ...base, kind: "skill", name: value }),
      ]],
      ["helper name", maximumToolInventoryHelperNameLength, [(value) => ({ ...base, kind: "helper", name: value, command: "x" })]],
      ["rule", maximumToolInventoryRuleLength, [(value) => ({ ...base, kind: "permission-rule", rule: value, detail: "x" })]],
      ["event", maximumToolInventoryEventLength, [(value) => ({ ...base, kind: "hook", event: value, command: "x" })]],
    ]
    for (const [field, cap, builds] of fields) {
      expect(cap, field).toBeGreaterThan(0)
      for (const build of builds) {
        expect(toolInventoryEntrySchema.safeParse(build("x".repeat(cap))).success, field).toBe(true)
        expect(toolInventoryEntrySchema.safeParse(build("x".repeat(cap + 1))).success, field).toBe(false)
      }
    }
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

describe("tool inventory text", () => {
  const remote = sample.providers[0].entries[1]
  const hook = sample.providers[0].entries[2]
  const rule = sample.providers[0].entries[4]
  const parses = (value: unknown) => toolInventorySchema.safeParse(value).success

  it("refuses a credential in any free-text field as a backstop to the reader's redaction", () => {
    const leaks = [
      "DATABASE_URL=postgres://u:p@db ./start.sh",
      "env API_KEY=abc123 npx mcp",
      "npx mcp --token=abc123",
      "npx mcp --api-key abc123",
      "curl -H 'Authorization: Bearer abc123def456'",
      "npx mcp ghp_abcdefghijklmnop1234",
      "npx mcp sk-proj-abcdefghijklmnop",
      "npx mcp AKIAABCDEFGHIJKLMNOP",
      "curl https://user:hunter2@db.internal/x",
      "npx mcp eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ]
    for (const leak of leaks) {
      expect(parses(withEntry({ ...server, command: leak })), `command ${leak}`).toBe(false)
      expect(parses(withEntry({ ...hook, command: leak })), `hook ${leak}`).toBe(false)
      expect(parses(withEntry({ ...rule, detail: `Bash(${leak})` })), `detail ${leak}`).toBe(false)
      expect(parses(withEntry({ ...server, name: leak.slice(0, 256) })), `name ${leak}`).toBe(false)
      expect(parses(claude((provider) => { (provider.files[2] as Record<string, unknown>).reason = leak })), `reason ${leak}`).toBe(false)
    }
    expect(parses(withEntry({ ...hook, matcher: "TOKEN=abc123" }))).toBe(false)
    expect(parses({ ...sample, repository: { ...sample.repository, root: "/src/SECRET=abc123" } })).toBe(false)
  })

  it("keeps commands the reader redacted, and ordinary flags", () => {
    for (const command of [
      "DATABASE_URL=[REDACTED] ./start.sh",
      "npx mcp --token=[REDACTED]",
      "npx mcp --api-key [REDACTED]",
      "git log --format=%H --port=5432",
      "npx -y @acme/pg-mcp --token-file ~/.config/pg",
    ]) expect(parses(withEntry({ ...server, command })), command).toBe(true)
    expect(parses(withEntry({ ...rule, detail: "Bash(pnpm test:*)" }))).toBe(true)
  })

  it("refuses line separators, format controls and padding in display text", () => {
    for (const name of ["a\u2028b", "a\u2029b", "a\u200bb", "a\u202eb", "a\u0085b", " padded", "padded "]) {
      expect(parses(withEntry({ ...server, name })), JSON.stringify(name)).toBe(false)
    }
  })

  it("takes environment keys as identifiers, unnormalized", () => {
    expect(parses(withEntry({ ...server, envKeys: ["_PRIVATE_1"] }))).toBe(true)
    for (const key of [" KEY", "KEY ", "TOKEN:madeup", "1KEY", "KEY-NAME", "K.EY"]) {
      expect(parses(withEntry({ ...server, envKeys: [key] })), key).toBe(false)
      expect(parses(withEntry({ kind: "env-key", key })), key).toBe(false)
    }
  })

  it("takes a real host and a port from 1 to 65535", () => {
    for (const host of ["mcp.linear.app", "localhost:3000", "127.0.0.1:65535", "[::1]:8080", "[2001:db8::1]", "xn--bcher-kva.example", "example.com.", "example.com.:443"]) {
      expect(parses(withEntry({ ...remote, host })), host).toBe(true)
    }
    for (const host of ["[:::]", "[.]", "[::1", "-bad-.com", "bad-.com", "a..b", "host:0", "host:99999", "host:080", "host:", "999.1.1.1", "1.2.3", "example.com..", ".", `${"a".repeat(64)}.com`]) {
      expect(parses(withEntry({ ...remote, host })), host).toBe(false)
    }
  })

  it("keeps a response well under the daemon's outbound limit, and counts what it left out", () => {
    // The daemon closes a connection whose buffered output reaches 1 MiB.
    expect(maximumToolInventoryBytes).toBeLessThanOrEqual(256 * 1_024)
    const big = { ...server, command: "x".repeat(2_000) }
    expect(parses(claude((provider) => { provider.entries = Array.from({ length: 200 }, () => big) }))).toBe(false)
    expect(parses(claude((provider) => { provider.entries = Array.from({ length: 100 }, () => big) }))).toBe(true)
    expect(parses(claude((provider) => { provider.omittedEntries = 100 }))).toBe(true)
    expect(parses(claude((provider) => { provider.omittedEntries = -1 }))).toBe(false)
    expect(parses(claude((provider) => { delete provider.omittedEntries }))).toBe(false)
  })

  it("leaves room in the budget for the JSON-RPC envelope around the largest request id", () => {
    // The worst id is 512 code units that JSON escapes to six bytes each.
    const envelope = (result: unknown) => new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "\u0001".repeat(512), result })).byteLength
    const overhead = envelope({}) - 2
    expect(maximumToolInventoryBytes + overhead).toBeLessThanOrEqual(256 * 1_024)
  })
})

describe("credential backstop", () => {
  const hookEntry = sample.providers[0].entries[2]
  it("reads each text once, not once per scheme word", () => {
    // Count every character a regular expression test reads on a near-miss
    // text: many scheme words, none a credential, no header.
    const scanned = (text: string) => {
      let total = 0
      const test = RegExp.prototype.test
      const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string) {
        total += String(input).length
        return test.call(this, input)
      })
      try {
        expect(holdsCredential(text)).toBe(false)
      } finally {
        spy.mockRestore()
      }
      return total
    }
    const phrase = "Token authentication failed "
    const small = scanned(phrase.repeat(Math.ceil(8 * 1_024 / phrase.length)))
    const large = scanned(phrase.repeat(Math.ceil(64 * 1_024 / phrase.length)))
    // Eight times the text reads about eight times as much; a rescan of the
    // text before each scheme word reads about sixty-four times as much.
    expect(large / small).toBeLessThan(12)
  })

  // Characters handed to String.prototype.matchAll, split by whether the
  // pattern opens on a quote (one that restarts at every quote of an unclosed
  // string) and by input length.
  const matchAllCalls = (run: () => void) => {
    const calls: { quoteOpened: boolean, length: number }[] = []
    const matchAll = RegExp.prototype[Symbol.matchAll] as (this: RegExp, input: string) => IterableIterator<RegExpMatchArray>
    const spy = vi.spyOn(RegExp.prototype as unknown as Record<symbol, typeof matchAll>, Symbol.matchAll).mockImplementation(function (this: RegExp, input: string) {
      calls.push({ quoteOpened: this.source.startsWith("\""), length: String(input).length })
      return matchAll.call(this, input)
    })
    try {
      run()
    } finally {
      spy.mockRestore()
    }
    return calls
  }

  it("reads quoted strings without a pattern that restarts at every quote", () => {
    // Backtracking inside one call cannot be counted from outside; a pattern
    // that opens on a quote retries from each of 16,384 escaped quotes.
    const calls = matchAllCalls(() => holdsCredential('\\"'.repeat(16_384)))
    expect(calls.filter(({ quoteOpened }) => quoteOpened).reduce((total, { length }) => total + length, 0)).toBe(0)
  })

  it("refuses an overlength text before the backstop reads it", () => {
    const command = '\\"'.repeat(16_384)
    let accepted = true
    const calls = matchAllCalls(() => { accepted = toolInventoryEntrySchema.safeParse({ ...hookEntry, command }).success })
    expect(accepted).toBe(false)
    expect(calls.filter(({ length }) => length > 2_048)).toEqual([])
  })

  it("trims a scheme value's punctuation without a pattern that restarts at every character", () => {
    // Backtracking inside one regular expression call cannot be counted from
    // outside, so count what can lead to it: characters handed to a
    // non-global replace, the suffix trim that restarts at each position of a
    // long punctuation run.
    let handed = 0
    const replace = RegExp.prototype[Symbol.replace] as (this: RegExp, input: string, replacement: string) => string
    const spy = vi.spyOn(RegExp.prototype as unknown as Record<symbol, typeof replace>, Symbol.replace).mockImplementation(function (this: RegExp, input: string, replacement: string) {
      if (!this.global) handed += String(input).length
      return replace.call(this, input, replacement)
    })
    try {
      holdsCredential(`Bearer ${".".repeat(32_768)}x`)
    } finally {
      spy.mockRestore()
    }
    expect(handed).toBe(0)
  })

  const hook = sample.providers[0].entries[2]
  const accepts = (command: string) => toolInventorySchema.safeParse(withEntry({ ...hook, command })).success

  // Each form a value can hide in, with a made-up value.
  it.each([
    ["env prefix", "PGPASSWORD=madeup-value psql"],
    ["quoted assignment", 'env "DATABASE_URL=madeup-value" ./start.sh'],
    ["single-quoted assignment", "'DATABASE_URL=madeup-value' ./start.sh"],
    ["JSON sensitive key", '{"apiKey":"madeup-value"}'],
    ["JSON env key", '{"DATABASE_URL": "madeup-value"}'],
    ["escaped JSON", '{\\"apiKey\\":\\"madeup-value\\"}'],
    ["YAML sensitive key", "apiKey: madeup-value"],
    ["YAML env key", "DATABASE_URL: madeup-value"],
    ["percent-encoded assignment", "DATABASE_URL%3Dmadeup-value"],
    ["percent-encoded flag", "--api-key%3Dmadeup-value"],
    ["unicode-escaped assignment", "DATABASE_URL\\u003dmadeup-value"],
    ["flag=value", "npx mcp --client-secret=madeup-value"],
    ["flag value", "npx mcp --password madeup-value"],
    ["marker with a value after it", "--api-key=[REDACTED]madeup-value"],
    ["assignment marker with a value after it", "API_KEY=[REDACTED]madeup-value"],
    ["authorization header", "curl -H 'Authorization: Bearer madeup-value'"],
    ["bearer token", "Bearer abc123def456"],
    ["basic credentials", "Authorization: Basic dXNlcjpwYXNz"],
    ["quoted marker joined to a word", 'API_KEY="[REDACTED]"madeupvalue ./start.sh'],
    ["single-quoted marker joined to a word", "npx mcp --api-key='[REDACTED]'madeupvalue"],
    ["ANSI-C hex escape", "env $'API_KEY\\x3dmadeupvalue' ./start.sh"],
    ["ANSI-C octal escape", "env $'API_KEY\\075madeupvalue' ./start.sh"],
    ["ANSI-C escape in a flag", "npx mcp $'--token\\x3dmadeupvalue'"],
    ["lowercase bearer value", "Bearer abcdefghijklmnopqrstuvwxyz"],
    ["opaque basic value", "curl -H 'Authorization: Basic abcdefghijkl'"],
    ["JSON argv flag", '["npx","mcp","--api-key","madeupvalue"]'],
    ["JSON argv scheme", '["curl","-H","Bearer","madeupvalue"]'],
    ["JSON argv assignment", '["env","DATABASE_URL=madeupvalue","./start.sh"]'],
    ["here-string assignment", 'cat <<<"DATABASE_URL=madeupvalue"'],
    ["unquoted here-string assignment", "cat <<<DATABASE_URL=madeupvalue"],
    ["authorization header before prose", "curl -H 'Authorization: Basic abcdefghijkl now'"],
    ["URL user without password", "https://madeup-value@example.test/x"],
    ["URL user and password", "https://user:madeup-value@example.test/x"],
    ["encoded URL", "https%3A%2F%2Fmadeup-value%40example.test"],
  ])("refuses a value in %s", (_form, command) => {
    expect(accepts(command)).toBe(false)
  })

  it.each([
    // The design's rows.
    "npx -y @acme/pg-mcp", "./scripts/dev-bootstrap.sh", "./scripts/guard-prod.sh", "gh-mcp serve",
    "afplay /System/Library/Sounds/Glass.aiff", "paplay /usr/share/sounds/freedesktop/stereo/complete.oga",
    "powershell -c [console]::beep(880,200)", "Bash(pnpm test:*)", "Read(./.env*)", "WebFetch(domain:docs.stripe.com)",
    "Bash(psql:*)", "EACCES · owned by root, mode 0600", "apiKeyHelper",
    // Names, paths and hosts.
    "Bearer Authentication", "Basic Authentication", "/Users/ada/.claude/settings.json", "C:\\Users\\ada\\.claude.json",
    "https://mcp.linear.app/mcp", "git@github.com:acme/api.git", "git log --format=%H --port=5432",
    "npx mcp --token-file ~/.config/pg", "npx mcp --api-key-env API_KEY", "llm --max-tokens 100",
    "EACCES: permission denied, open '/Users/ada/.claude/settings.local.json'",
    "Token limit exceeded", "Basic usage information", "Token limit exceeded.", "Basic usage information, see docs.", "Basic credentials.", "Bearer token.",
    // The marker, alone or ending a sentence; and a scheme word before an ellipsis.
    "Bearer [REDACTED]", "Bearer [REDACTED].", "Authorization: Bearer [REDACTED].", "Bearer ...", "Basic authentication.", '{"reason":"Token limit exceeded."}', 'cat <<<"/tmp/config=dev/index.js"', '["node","/tmp/config=dev/index.js"]',
    '["npx","mcp","--api-key","[REDACTED]"]',
    "node /tmp/config=dev/index.js", "Bearer token", "bearer auth header", "openssl dgst --digest sha256 ./build.tar",
    'API_KEY="[REDACTED]" ./start.sh', "env $'API_KEY=[REDACTED]' ./start.sh", "echo $'unclosed\\",
    // What the reader's redaction writes.
    "DATABASE_URL=[REDACTED] ./start.sh", 'env "DATABASE_URL=[REDACTED]" ./start.sh', '{"apiKey":"[REDACTED]"}',
    "npx mcp --api-key [REDACTED]", "npx mcp --api-key=[REDACTED]", "curl -H 'Authorization: Bearer [REDACTED]'",
    "https://[REDACTED]@example.test/x",
  ])("keeps %s", (command) => {
    expect(accepts(command)).toBe(true)
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
    expect(approvalRequestSchema.safeParse({ ...approval, value: "postgres://u:p@db" }).success).toBe(false)
    expect(approvalRequestSchema.safeParse({ ...approval, toolServer: { ...approval.toolServer, file: "TOKEN=abc123" } }).success).toBe(false)
  })

  // An agent's own server is named as the agent names it: the daemon did not
  // read the file that declared it, so it states no file, source or transport.
  it("names a server whose declaring file the daemon did not read", () => {
    const named = { ...approval, toolServer: { name: "github" } }
    expect(approvalRequestSchema.parse(named)).toEqual(named)
    const connected = { ...approval, toolServer: { name: "github", transport: "http" } }
    expect(approvalRequestSchema.parse(connected)).toEqual(connected)
  })

  it("names a declaring file only with its source", () => {
    expect(approvalRequestSchema.safeParse({ ...approval, toolServer: { name: "github", file: ".mcp.json" } }).success).toBe(false)
    expect(approvalRequestSchema.safeParse({ ...approval, toolServer: { name: "github", source: "repository-file" } }).success).toBe(false)
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
