import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import type { ToolInventoryEntry } from "@getdomovoi/protocol"

import {
  openCodeEntryHeldBack,
  openCodeRepositoryFiles,
  openCodeRepositoryLoad,
  withoutOwnOpenCodeServers,
} from "./opencode-repository-trust.js"
import { readRepositoryProviderConfig, type RepositoryConfigDocuments } from "./repository-provider-config.js"

const local = (extra: Record<string, unknown> = {}) => ({ type: "local", command: ["db-mcp", "--port", "1"], ...extra })
const remote = (extra: Record<string, unknown> = {}) => ({ type: "remote", url: "https://mcp.example.com/mcp", ...extra })
// OpenCode passes its own environment, the embedded server's password
// included, to a local server it starts; the passed server's environment
// blanks it.
const blank = { OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "" }

describe("openCodeRepositoryLoad", () => {
  it("passes the mcp entries of OpenCode's config files with their own fields only", () => {
    const load = openCodeRepositoryLoad("opencode", {
      "opencode.json": {
        mcp: {
          db: local({ environment: { DATABASE_URL: "postgres://db", PATH: "/repo/bin", NODE_OPTIONS: "--require x", OPENCODE_CONFIG: "x" }, timeout: 9000, enabled: true }),
          docs: remote({ headers: { "X-Team": "core" }, oauth: { clientId: "x" } }),
        },
        plugin: ["formatter"],
        permission: { "*": "allow" },
      },
      ".opencode/opencode.jsonc": { mcp: { search: remote() } },
    })
    expect(load.mcpServers).toEqual({
      db: { type: "local", command: ["db-mcp", "--port", "1"], environment: { DATABASE_URL: "postgres://db", ...blank }, timeout: 9000, enabled: true },
      docs: { type: "remote", url: "https://mcp.example.com/mcp", headers: { "X-Team": "core" }, oauth: false },
      search: { type: "remote", url: "https://mcp.example.com/mcp", oauth: false },
    })
    expect(load.filteredEnvKeys).toEqual({ db: ["PATH", "NODE_OPTIONS", "OPENCODE_CONFIG"] })
  })

  it("blanks the embedded server's password in a local server that sets no environment", () => {
    expect(openCodeRepositoryLoad("opencode", { "opencode.json": { mcp: { db: local() } } }).mcpServers.db)
      .toEqual({ type: "local", command: ["db-mcp", "--port", "1"], environment: blank })
  })

  it("holds a server back for a field Domovoi does not pass, a disabled or partial entry, or a bad command", () => {
    const load = openCodeRepositoryLoad("opencode", {
      "opencode.json": {
        mcp: {
          cwd: local({ cwd: "tools" }),
          env: local({ env: { A: "1" } }),
          disabled: local({ enabled: false }),
          partial: { enabled: true },
          empty: { type: "local", command: [] },
          numbers: { type: "local", command: ["db", 1] },
          kind: { type: "stdio", command: ["db"] },
          zero: local({ timeout: 0 }),
          ok: local(),
        },
      },
    })
    expect(Object.keys(load.mcpServers)).toEqual(["ok"])
  })

  // Ruling Q151 A: OpenCode fills in {env:} and {file:} when it reads a config
  // file, and mcp.add takes the values as written, so a server naming a
  // variable or a file is held back; a remote address or header with `$` too.
  it("holds a server back that names a variable or a file", () => {
    const load = openCodeRepositoryLoad("opencode", {
      "opencode.json": {
        mcp: {
          token: remote({ headers: { Authorization: "Bearer {env:TOKEN}" } }),
          dollar: remote({ url: "https://mcp.example.com/${TEAM}" }),
          headerName: remote({ headers: { "X-{file:./k}": "v" } }),
          argument: local({ command: ["db-mcp", "--key", "{file:./secret}"] }),
          value: local({ environment: { KEY: "{env:KEY}" } }),
          shellDollar: local({ command: ["db-mcp", "$HOME"] }),
        },
      },
    })
    expect(Object.keys(load.mcpServers)).toEqual(["shellDollar"])
  })

  // Ruling Q231 A: a name declared in two of the files is held back.
  it("holds back a name declared in two config files", () => {
    const load = openCodeRepositoryLoad("kilo", {
      "kilo.json": { mcp: { db: local(), only: local() } },
      ".kilo/kilo.json": { mcp: { db: { enabled: false } } },
    })
    expect(Object.keys(load.mcpServers)).toEqual(["only"])
  })

  it("blanks Kilo's own password names for a Kilo server", () => {
    expect(openCodeRepositoryLoad("kilo", { "kilo.json": { mcp: { db: local() } } }).mcpServers.db)
      .toEqual({ type: "local", command: ["db-mcp", "--port", "1"], environment: { KILO_SERVER_PASSWORD: "", KILO_SERVER_USERNAME: "" } })
  })

  it("reads each provider's own files only", () => {
    const documents: RepositoryConfigDocuments = {
      "opencode.json": { mcp: { shared: local() } },
      ".opencode/opencode.json": { mcp: { opencodeOnly: local() } },
      "kilo.json": { mcp: { kiloOnly: local() } },
    }
    expect(Object.keys(openCodeRepositoryLoad("opencode", documents).mcpServers)).toEqual(["shared", "opencodeOnly"])
    expect(Object.keys(openCodeRepositoryLoad("kilo", documents).mcpServers)).toEqual(["kiloOnly", "shared"])
  })

  it("holds back a name a card could not show as written", () => {
    const load = openCodeRepositoryLoad("opencode", { "opencode.json": { mcp: { "my.docs": local(), [`x${"y".repeat(64)}`]: local(), fine_name: local() } } })
    expect(Object.keys(load.mcpServers)).toEqual(["fine_name"])
  })
})

describe("documents a trusted read returns for OpenCode and Kilo", () => {
  it("are their config files as the digest read them, comments allowed", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-opencode-trust-"))
    try {
      await mkdir(join(root, ".kilo"))
      await writeFile(join(root, "opencode.jsonc"), "{\n  // the team's database\n  \"mcp\": { \"db\": { \"type\": \"local\", \"command\": [\"db-mcp\"] } },\n}\n")
      await writeFile(join(root, ".kilo", "kilo.json"), JSON.stringify({ mcp: { search: { type: "remote", url: "https://mcp.example.com" } } }))
      const config = await readRepositoryProviderConfig(root, { heldBack: true, documents: true })
      expect(Object.keys(openCodeRepositoryLoad("opencode", config.documents).mcpServers)).toEqual(["db"])
      expect(Object.keys(openCodeRepositoryLoad("kilo", config.documents).mcpServers)).toEqual(["db", "search"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Ruling Q150 A: mcp.add replaces a server of the same name, and a tool's key
// joins server and tool with one `_`, so a repository server whose key prefix
// could be one of the person's is held back.
describe("withoutOwnOpenCodeServers", () => {
  it("holds back a name like one of the person's, in any case or by prefix either way", () => {
    const servers = Object.fromEntries(["Github", "git", "docs_v2", "slack", "my_db", "my-db"].map((name) => [name, { type: "local" as const, command: ["x"] }]))
    // my.db's tools start my_db_; my-db's start my-db_, so those two differ.
    expect(Object.keys(withoutOwnOpenCodeServers(servers, ["github", "git_hub", "docs", "my.db"]))).toEqual(["slack", "my-db"])
  })
})

describe("openCodeEntryHeldBack", () => {
  const server = (name: string, file: string): ToolInventoryEntry => ({
    kind: "tool-server", name, transport: "stdio", command: "db-mcp", envKeys: [], file, startsAtSessionStart: true, heldBack: true,
  })
  it("reports a server that passes as loading, and everything else from the files as held back", () => {
    const load = openCodeRepositoryLoad("opencode", { "opencode.json": { mcp: { db: local(), off: local({ enabled: false }) }, plugin: ["formatter"] } })
    expect(openCodeEntryHeldBack(server("db", "opencode.json"), load)).toBe(false)
    expect(openCodeEntryHeldBack(server("off", "opencode.json"), load)).toBe(true)
    expect(openCodeEntryHeldBack({ kind: "plugin", name: "formatter", file: "opencode.json", startsAtSessionStart: true, heldBack: true }, load)).toBe(true)
  })

  it("lists every config file it reads", () => {
    expect([...openCodeRepositoryFiles.opencode]).toEqual(["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"])
    expect(openCodeRepositoryFiles.kilo.has(".kilocode/config.json")).toBe(true)
    expect(openCodeRepositoryFiles.kilo.has(".kilo/mcp.json")).toBe(false)
  })
})
