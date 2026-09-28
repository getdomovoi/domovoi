import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createEmptyWorkspace,
  demoWorkspace,
  maximumToolInventoryBytes,
  protocolVersion,
  toolInventorySchema,
  type ToolInventory,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { DeviceCredentialBinding as DeviceBinding } from "./device-registry.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { type DaemonServerOptions as DomovoiDaemonOptions, DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

// tool.inventory answers what the open repository's own agent configuration
// declares (slice P3). Until the trust store exists (P5), no repository is
// trusted.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const directories: string[] = []
const rpcDeadlineMs = 10_000
const projectId = "project-acme"

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "domovoi-tool-inventory-"))
  directories.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...path.split("/")), content)
  }
  return root
}

async function fixture(root: string | undefined, options: Partial<DomovoiDaemonOptions> = {}) {
  const empty = createEmptyWorkspace(demoWorkspace.machine)
  const snapshot: WorkspaceSnapshot = root === undefined ? empty : {
    ...empty,
    project: { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: root, branch: "main" },
  }
  const store = new SqliteWorkspaceStore(":memory:", snapshot)
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", store, errorSink: vi.fn(), ...options })
  daemons.push(daemon)
  await daemon.start()
  return { daemon, store }
}

async function connect(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(rpcDeadlineMs) })
  let id = 0
  return async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new Error(`${method} deadline expired`))), rpcDeadlineMs)
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        socket.off("message", receive)
        finish()
      }
      const receive = (data: WebSocket.RawData) => {
        const reply = JSON.parse(data.toString()) as Record<string, unknown>
        if (reply.id === requestId) settle(() => resolve(reply))
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
}

async function hello(daemon: DomovoiDaemon, client: string, authToken: string) {
  const call = await connect(daemon)
  const reply = await call("system.hello", { client, clientVersion: "0.0.1", protocolVersion, authToken })
  expect(reply, `hello as ${client}`).toHaveProperty("result")
  return call
}

const configured = {
  ".mcp.json": JSON.stringify({ mcpServers: { postgres: { command: "npx", args: ["-y", "@acme/pg-mcp"], env: { DATABASE_URL: "postgres://db" } } } }),
  ".claude/settings.json": JSON.stringify({
    permissions: { allow: ["Bash(pnpm test:*)"] },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./scripts/bootstrap.sh" }] }] },
  }),
  ".codex/config.toml": "sandbox_mode = \"workspace-write\"\n\n[mcp_servers.docs]\nurl = \"https://mcp.example.com/mcp\"\n",
  "opencode.json": JSON.stringify({ mcp: { linear: { type: "remote", url: "https://mcp.linear.app/sse" } }, permission: { bash: "ask" } }),
}

function inventoryOf(reply: Record<string, unknown>): ToolInventory {
  expect(reply).not.toHaveProperty("error")
  const parsed = toolInventorySchema.safeParse(reply.result)
  expect(parsed.success).toBe(true)
  return parsed.data!
}

const provider = (inventory: ToolInventory, name: string) => inventory.providers.find((entry) => entry.provider === name)

describe("tool.inventory", () => {
  it("answers a schema-valid inventory of the open repository's Claude Code, Codex and OpenCode configuration", async () => {
    const root = await repository(configured)
    const { daemon } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)

    const inventory = inventoryOf(await call("tool.inventory", {}))
    const read = await readRepositoryProviderConfig(root, { heldBack: false })

    expect(inventory.repository).toEqual({
      projectId,
      root,
      configDigest: read.configDigest,
      trust: { state: "untrusted", reason: "not-trusted" },
    })
    expect(inventory.providers.map((entry) => entry.provider)).toEqual(read.providers.map((entry) => entry.provider))
    expect(provider(inventory, "claude-code")?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool-server", name: "postgres", transport: "stdio", envKeys: ["DATABASE_URL"], file: ".mcp.json" }),
      expect.objectContaining({ kind: "hook", event: "SessionStart", file: ".claude/settings.json" }),
    ]))
    expect(provider(inventory, "codex")?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool-server", name: "docs", transport: "http", host: "mcp.example.com", file: ".codex/config.toml" }),
      expect.objectContaining({ kind: "permission-rule", rule: "sandbox_mode", detail: "workspace-write" }),
    ]))
    expect(provider(inventory, "opencode")?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool-server", name: "linear", transport: "http", host: "mcp.linear.app", file: "opencode.json" }),
    ]))
    for (const entry of inventory.providers) expect(entry.toolServers, entry.provider).toBe("read-from-files")
    expect(JSON.stringify(inventory)).not.toContain("postgres://db")
  })

  it("keeps the digest the reader computes, and a changed file changes it", async () => {
    const root = await repository(configured)
    const { daemon } = await fixture(root)
    const call = await hello(daemon, "web", daemon.authToken)
    const before = inventoryOf(await call("tool.inventory", {}))
    await writeFile(join(root, ".codex", "config.toml"), "sandbox_mode = \"danger-full-access\"\n")
    const after = inventoryOf(await call("tool.inventory", {}))

    expect(after.repository?.configDigest).toBe((await readRepositoryProviderConfig(root, { heldBack: false })).configDigest)
    expect(after.repository?.configDigest).not.toBe(before.repository?.configDigest)
    expect(after.repository?.trust).toEqual({ state: "untrusted", reason: "not-trusted" })
  })

  it("lists no providers and no repository when no project is open", async () => {
    const { daemon } = await fixture(undefined)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const inventory = inventoryOf(await call("tool.inventory", {}))
    expect(inventory.repository).toBeUndefined()
    expect(inventory.providers).toEqual([])
  })

  it.each<[string, DeviceBinding]>([
    ["phone", { kind: "client", client: "phone", clientAccess: "full" }],
    ["tablet", { kind: "client", client: "tablet", clientAccess: "full" }],
    ["phone", { kind: "client", client: "phone", clientAccess: "watching" }],
    ["desktop", { kind: "client", client: "desktop", clientAccess: "watching" }],
    ["web", { kind: "client", client: "web", clientAccess: "watching" }],
  ])("treats a %s credential (%o) the way skill.inventory does", async (client, binding) => {
    const root = await repository(configured)
    const { daemon, store } = await fixture(root)
    const { token } = store.devices.pair({ label: client, binding })
    const call = await hello(daemon, client, token)
    const skill = await call("skill.inventory", {})
    const tool = await call("tool.inventory", {})
    if (binding.kind === "client" && (binding.client === "phone" || binding.client === "tablet")) {
      expect(skill).toHaveProperty("error")
      expect(tool.error).toEqual(skill.error)
    } else {
      expect(skill).toHaveProperty("result")
      inventoryOf(tool)
    }
  })

  it("refuses a connection that has not said hello the way skill.inventory does", async () => {
    const root = await repository(configured)
    const { daemon } = await fixture(root)
    const call = await connect(daemon)
    const skill = await call("skill.inventory", {})
    expect(skill).toHaveProperty("error")
    expect((await call("tool.inventory", {})).error).toEqual(skill.error)
  })

  it("answers a reader failure with the daemon's internal error, naming no path or value", async () => {
    const root = await repository(configured)
    const errorSink = vi.fn()
    const { daemon } = await fixture(root, {
      errorSink,
      repositoryProviderConfig: async () => {
        throw new Error("The codex repository inventory does not fit the protocol")
      },
    })
    const call = await hello(daemon, "desktop", daemon.authToken)
    const reply = await call("tool.inventory", {})

    expect(reply).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal daemon error" } })
    expect(JSON.stringify(reply)).not.toContain(root)
    expect(errorSink).toHaveBeenCalled()
  })

  it("never sends an inventory the protocol refuses", async () => {
    const root = await repository(configured)
    const { daemon } = await fixture(root, {
      repositoryProviderConfig: async () => ({
        configDigest: "not-a-digest",
        providers: [],
        trustRefusals: [],
      }),
    })
    const call = await hello(daemon, "desktop", daemon.authToken)
    expect(await call("tool.inventory", {})).toMatchObject({ error: { code: -32603, message: "Internal daemon error" } })
  })

  it("fits a large configuration within the byte budget and counts what it leaves out", async () => {
    // Each file stays under the reader's 256 KiB file cap; together they hold
    // far more than one response may carry.
    const words = (index: number) => `pnpm run task${index} ${"word ".repeat(180).trim()}`
    const rules = Array.from({ length: 250 }, (_, index) => `Bash(${words(index)})`)
    const servers = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`server${index}`, { command: "node", args: words(index).split(" ") }]))
    const agents = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`formatter${index}`, { command: words(index).split(" ") }]))
    const root = await repository({
      ".claude/settings.json": JSON.stringify({ permissions: { allow: rules } }),
      ".mcp.json": JSON.stringify({ mcpServers: servers }),
      "opencode.json": JSON.stringify({ formatter: agents }),
    })
    const read = await readRepositoryProviderConfig(root, { heldBack: false })
    const readEntries = read.providers.reduce((total, entry) => total + entry.entries.length, 0)
    expect(new TextEncoder().encode(JSON.stringify(read.providers)).byteLength).toBeGreaterThan(maximumToolInventoryBytes)

    const { daemon } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const reply = await call("tool.inventory", {})
    const inventory = inventoryOf(reply)

    expect(new TextEncoder().encode(JSON.stringify(inventory)).byteLength).toBeLessThanOrEqual(maximumToolInventoryBytes)
    const listed = inventory.providers.reduce((total, entry) => total + entry.entries.length, 0)
    const omitted = inventory.providers.reduce((total, entry) => total + entry.omittedEntries, 0)
    const readOmitted = read.providers.reduce((total, entry) => total + entry.omittedEntries, 0)
    expect(listed).toBeGreaterThan(0)
    expect(listed).toBeLessThan(readEntries)
    expect(listed + omitted).toBe(readEntries + readOmitted)
    for (const entry of inventory.providers) {
      const source = read.providers.find((candidate) => candidate.provider === entry.provider)!
      // What is listed is what the reader read, in its order.
      expect(entry.entries).toEqual(source.entries.slice(0, entry.entries.length))
    }
  })
})
