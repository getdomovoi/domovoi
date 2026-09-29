import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { constants, DatabaseSync } from "node:sqlite"

import {
  createEmptyWorkspace,
  demoWorkspace,
  maximumRepositoryTrustRefusals,
  protocolVersion,
  rpcMethods,
  toolInventorySchema,
  type RepositoryTrust,
  type ToolInventory,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { SqliteRepositoryTrust, maximumRepositoryTrustRecords } from "./repository-trust-store.js"
import { type DaemonServerOptions as DomovoiDaemonOptions, DomovoiDaemon, repositoryTrustProjectRefusal } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

// Slice P5: the daemon records repository trust, pinned to the configuration
// digest the person reviewed, and reports it. Nothing loads under it yet.

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
  const root = await mkdtemp(join(tmpdir(), "domovoi-repository-trust-"))
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

async function hello(daemon: DomovoiDaemon, client: string, authToken: string) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(rpcDeadlineMs) })
  let id = 0
  const call = async (method: string, params: Record<string, unknown>) => {
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
  expect(await call("system.hello", { client, clientVersion: "0.0.1", protocolVersion, authToken }), `hello as ${client}`).toHaveProperty("result")
  return call
}

const configured = {
  ".mcp.json": JSON.stringify({ mcpServers: { postgres: { command: "npx", args: ["-y", "@acme/pg-mcp"] } } }),
  ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./scripts/bootstrap.sh" }] }] } }),
}

type Call = Awaited<ReturnType<typeof hello>>

async function inventory(call: Call): Promise<ToolInventory> {
  const reply = await call("tool.inventory", {})
  expect(reply).not.toHaveProperty("error")
  return toolInventorySchema.parse(reply.result)
}

async function trust(call: Call, configDigest: string, client = "desktop") {
  const reply = await call("repository.trust", { projectId, configDigest, client })
  expect(reply).not.toHaveProperty("error")
  return rpcMethods["repository.trust"].result.parse(reply.result)
}

async function revoke(call: Call, client = "desktop") {
  const reply = await call("repository.revokeTrust", { projectId, client })
  expect(reply).not.toHaveProperty("error")
  return rpcMethods["repository.revokeTrust"].result.parse(reply.result)
}

const digestOf = async (root: string) => (await readRepositoryProviderConfig(root, { heldBack: false })).configDigest

describe("repository.trust", () => {
  it("records trust for the reviewed digest, and tool.inventory reports it", async () => {
    const root = await repository(configured)
    const { daemon, store } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const before = await inventory(call)
    expect(before.repository?.trust).toEqual({ state: "untrusted", reason: "not-trusted" })

    const result = await trust(call, before.repository!.configDigest)
    expect(result.outcome).toBe("trusted")
    expect(result.repository).toMatchObject({
      projectId,
      configDigest: before.repository!.configDigest,
      trust: { state: "trusted", trustedDigest: before.repository!.configDigest, trustedBy: { client: "desktop" } },
    })
    // The owner's bearer names no client id: any process running as the owner holds it.
    expect(result.repository.trust).not.toHaveProperty("trustedBy.clientId")
    expect(store.repositoryTrust.find(projectId)).toMatchObject({ trustedDigest: before.repository!.configDigest })

    const after = await inventory(call)
    expect(after.repository?.trust).toEqual(result.repository.trust)
    // Trust is recorded, not applied (ruling Q128 A): nothing is held back.
    for (const provider of after.providers) {
      for (const entry of provider.entries) expect(entry.heldBack, provider.provider).toBe(false)
    }
  })

  it("names the owner's bearer as desktop whatever client it declared (ruling Q68)", async () => {
    const root = await repository(configured)
    const { daemon } = await fixture(root)
    const call = await hello(daemon, "web", daemon.authToken)
    const result = await trust(call, await digestOf(root), "web")
    expect(result.repository.trust).toMatchObject({ state: "trusted", trustedBy: { client: "desktop" } })
  })

  it("names a paired credential's client and device id", async () => {
    const root = await repository(configured)
    const { daemon, store } = await fixture(root)
    const { token, device } = store.devices.pair({ label: "browser", binding: { kind: "client", client: "web", clientAccess: "full" } })
    const call = await hello(daemon, "web", token)
    const result = await trust(call, await digestOf(root), "web")
    expect(result.repository.trust).toMatchObject({ state: "trusted", trustedBy: { client: "web", clientId: device.id } })
  })

  it("records nothing and answers config-changed when the reviewed digest is not the current one", async () => {
    const root = await repository(configured)
    const { daemon, store } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const current = await digestOf(root)

    const result = await trust(call, `sha256:${"0".repeat(64)}`)
    expect(result).toEqual({
      outcome: "config-changed",
      repository: { projectId, configDigest: current, trust: { state: "untrusted", reason: "not-trusted" } },
    })
    expect(store.repositoryTrust.find(projectId)).toBeUndefined()
  })

  it("reports a changed configuration with the earlier grant until it is trusted anew", async () => {
    const root = await repository(configured)
    const { daemon } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const reviewed = await digestOf(root)
    const granted = await trust(call, reviewed)
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "node" } } }))

    const changed = await inventory(call)
    expect(changed.repository?.configDigest).not.toBe(reviewed)
    expect(changed.repository?.trust).toEqual({ ...granted.repository.trust, state: "untrusted", reason: "config-changed" })

    // The digest the person saw before the change no longer grants anything.
    const stale = await trust(call, reviewed)
    expect(stale).toEqual({ outcome: "config-changed", repository: { projectId, configDigest: changed.repository!.configDigest, trust: changed.repository!.trust } })

    const renewed = await trust(call, changed.repository!.configDigest)
    expect(renewed.outcome).toBe("trusted")
    expect((await inventory(call)).repository?.trust).toMatchObject({ state: "trusted", trustedDigest: changed.repository!.configDigest })
  })

  it("refuses a project that is not the open one, naming no path or value", async () => {
    const root = await repository(configured)
    const { daemon, store } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const digest = await digestOf(root)
    for (const [method, params] of [
      ["repository.trust", { projectId: "project-other", configDigest: digest, client: "desktop" }],
      ["repository.revokeTrust", { projectId: "project-other", client: "desktop" }],
    ] as const) {
      expect(await call(method, params), method).toMatchObject({ error: { code: -32602, message: repositoryTrustProjectRefusal } })
    }
    expect(store.repositoryTrust.find("project-other")).toBeUndefined()
    expect(store.repositoryTrust.find(projectId)).toBeUndefined()
  })

  it("refuses when no project is open", async () => {
    const { daemon } = await fixture(undefined)
    const call = await hello(daemon, "desktop", daemon.authToken)
    expect(await call("repository.trust", { projectId, configDigest: `sha256:${"a".repeat(64)}`, client: "desktop" }))
      .toMatchObject({ error: { code: -32602, message: repositoryTrustProjectRefusal } })
    expect(await call("repository.revokeTrust", { projectId, client: "desktop" }))
      .toMatchObject({ error: { code: -32602, message: repositoryTrustProjectRefusal } })
  })

  it("answers a reader failure with the daemon's internal error and records nothing", async () => {
    const root = await repository(configured)
    const { daemon, store } = await fixture(root, {
      repositoryProviderConfig: async () => {
        throw new Error("The codex repository inventory does not fit the protocol")
      },
    })
    const call = await hello(daemon, "desktop", daemon.authToken)
    const reply = await call("repository.trust", { projectId, configDigest: `sha256:${"a".repeat(64)}`, client: "desktop" })
    expect(reply).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal daemon error" } })
    expect(JSON.stringify(reply)).not.toContain(root)
    expect(store.repositoryTrust.find(projectId)).toBeUndefined()
  })

  it("records nothing when an emergency stop cancels it during the configuration read", async () => {
    const root = await repository(configured)
    const digest = await digestOf(root)
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const { daemon, store } = await fixture(root, {
      repositoryProviderConfig: async (path, options) => {
        started()
        await released
        return readRepositoryProviderConfig(path, options)
      },
    })
    const call = await hello(daemon, "desktop", daemon.authToken)
    const pending = call("repository.trust", { projectId, configDigest: digest, client: "desktop" })
    await reading
    const stop = await call("system.emergencyStop", { client: "desktop" })
    expect(stop).toMatchObject({ result: { outcomes: { mutationsCancelled: 1 } } })
    release()

    expect(await pending).toMatchObject({ error: { code: -32603, message: "Operation cancelled by emergency stop" } })
    expect(store.repositoryTrust.find(projectId)).toBeUndefined()
  })

  it.skipIf(typeof (DatabaseSync.prototype as { setAuthorizer?: unknown }).setAuthorizer !== "function")(
    "reports the repository untrusted at once when a failed grant cannot be rolled back",
    async () => {
      const root = await repository(configured)
      const database = new DatabaseSync(":memory:")
      const repositoryTrust = new SqliteRepositoryTrust(database)
      for (let index = 0; index < maximumRepositoryTrustRecords; index += 1) {
        repositoryTrust.record({ projectId: `project-${index}`, trustedDigest: `sha256:${"a".repeat(64)}`, trustedBy: { client: "desktop" } })
      }
      // The trim's DELETE and the savepoint rollback are refused.
      database.setAuthorizer((action, operation) => action === constants.SQLITE_DELETE || (action === constants.SQLITE_SAVEPOINT && operation === "ROLLBACK")
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK)
      const { daemon } = await fixture(root, { repositoryTrust })
      const call = await hello(daemon, "desktop", daemon.authToken)

      expect(await call("repository.trust", { projectId, configDigest: await digestOf(root), client: "desktop" }))
        .toMatchObject({ error: { code: -32603, message: "Internal daemon error" } })
      expect((await inventory(call)).repository?.trust).toEqual({ state: "untrusted", reason: "not-trusted" })
    },
  )

  it("uses the trust store it is given", async () => {
    const root = await repository(configured)
    const repositoryTrust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    const { daemon, store } = await fixture(root, { repositoryTrust })
    const call = await hello(daemon, "desktop", daemon.authToken)
    await trust(call, await digestOf(root))
    expect(repositoryTrust.find(projectId)).toBeDefined()
    expect(store.repositoryTrust.find(projectId)).toBeUndefined()
  })
})

describe("a repository that cannot be trusted (ruling Q121 A)", () => {
  const outside = { ...configured, ".codex/config.toml": "model_instructions_file = \"~/policy.txt\"\n" }
  const refused = { state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "instructions-outside", path: "~/policy.txt" }], omittedRefusals: 0 }

  it("is reported with its refusals, and trust is not granted", async () => {
    const root = await repository(outside)
    const { daemon, store } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const listed = await inventory(call)
    expect(listed.repository?.trust).toEqual(refused)

    const result = await trust(call, listed.repository!.configDigest)
    expect(result).toEqual({ outcome: "cannot-trust", repository: { projectId, configDigest: listed.repository!.configDigest, trust: refused } })
    expect(store.repositoryTrust.find(projectId)).toBeUndefined()
  })

  it("is reported as such even with an earlier grant on record", async () => {
    const root = await repository(configured)
    const { daemon } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    await trust(call, await digestOf(root))
    await mkdir(join(root, ".codex"), { recursive: true })
    await writeFile(join(root, ".codex", "config.toml"), outside[".codex/config.toml"])
    expect((await inventory(call)).repository?.trust).toEqual(refused)
    expect((await revoke(call)).repository.trust).toEqual(refused)
  })

  it("lists at most the protocol's cap and counts the rest", async () => {
    const root = await repository(configured)
    const extra = 5
    const { daemon } = await fixture(root, {
      repositoryProviderConfig: async (path, options) => ({
        ...await readRepositoryProviderConfig(path, options),
        trustRefusals: Array.from({ length: maximumRepositoryTrustRefusals + extra }, (_, index) => ({ provider: "codex", reason: "nested-config" as const, path: `packages/p${index}/.codex` })),
      }),
    })
    const call = await hello(daemon, "desktop", daemon.authToken)
    const state = (await inventory(call)).repository?.trust
    expect(state).toMatchObject({ state: "untrusted", reason: "cannot-trust", omittedRefusals: extra })
    expect(state?.state === "untrusted" && state.reason === "cannot-trust" ? state.refusals.map((refusal) => refusal.path) : [])
      .toEqual(Array.from({ length: maximumRepositoryTrustRefusals }, (_, index) => `packages/p${index}/.codex`))
  })
})

describe("repository.revokeTrust", () => {
  it("takes the grant back and reports the repository not trusted, restarting no threads in P5", async () => {
    const root = await repository(configured)
    const { daemon, store } = await fixture(root)
    const call = await hello(daemon, "desktop", daemon.authToken)
    const digest = await digestOf(root)
    await trust(call, digest)

    const result = await revoke(call, "desktop")
    const expected: RepositoryTrust = { projectId, configDigest: digest, trust: { state: "untrusted", reason: "not-trusted" } }
    expect(result).toEqual({ repository: expected, threads: [] })
    expect(store.repositoryTrust.find(projectId)).toBeUndefined()
    expect((await inventory(call)).repository?.trust).toEqual({ state: "untrusted", reason: "not-trusted" })
    // Revoking what is not trusted is not an error.
    expect(await revoke(call, "desktop")).toEqual({ repository: expected, threads: [] })
  })

  it("answers the internal error, not not-trusted, when the grant survives the delete", async () => {
    const root = await repository(configured)
    const database = new DatabaseSync(":memory:")
    const repositoryTrust = new SqliteRepositoryTrust(database)
    repositoryTrust.record({ projectId, trustedDigest: await digestOf(root), trustedBy: { client: "desktop" } })
    database.exec("CREATE TRIGGER keep_grant BEFORE DELETE ON repository_trust BEGIN SELECT RAISE(IGNORE); END")
    const { daemon } = await fixture(root, { repositoryTrust })
    const call = await hello(daemon, "desktop", daemon.authToken)

    expect(await call("repository.revokeTrust", { projectId, client: "desktop" }))
      .toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal daemon error" } })
    expect(repositoryTrust.find(projectId)).toBeDefined()
  })

  it("takes the grant back even when the configuration cannot be read", async () => {
    const root = await repository(configured)
    const repositoryTrust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    repositoryTrust.record({ projectId, trustedDigest: await digestOf(root), trustedBy: { client: "desktop" } })
    const { daemon } = await fixture(root, {
      repositoryTrust,
      repositoryProviderConfig: async () => {
        throw new Error("The codex repository inventory does not fit the protocol")
      },
    })
    const call = await hello(daemon, "desktop", daemon.authToken)
    const reply = await call("repository.revokeTrust", { projectId, client: "desktop" })
    expect(reply).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal daemon error" } })
    expect(repositoryTrust.find(projectId)).toBeUndefined()
  })
})
