import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"

import {
  daemonAuthenticationErrorCode, devicePairResultSchema, fleetEnrollResultSchema,
  fleetSnapshotSchema, fleetSnapshotOverflowSchema, fleetSnapshotOverflowErrorCode, maximumFleetEntries, protocolVersion, rpcMethods, workspaceSnapshotSchema,
  type FleetSnapshot, type RpcMethod, type RpcParams,
} from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import type { AgentAdapter } from "./agents.js"
import { MachineCredentialStore, machineCredentialDigest } from "./machine-credentials.js"
import { SqliteFleetRegistry } from "./fleet-registry.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies, type ProductionDaemonHandle } from "./production-daemon.js"
import { DomovoiDaemon } from "./server.js"
import { removeScratchDirectories } from "./test-scratch.js"

const exec = promisify(execFile)
const roots: string[] = []
const daemons: ProductionDaemonHandle[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  await removeScratchDirectories(roots.splice(0))
})

async function scratch() {
  const path = await mkdtemp(join(tmpdir(), "domovoi-fleet-production-"))
  roots.push(path)
  return path
}

// Only external platform/provider dependencies are substituted. Identity,
// SQLite, Git, enrollment, timers, routing and every RPC use production code.
async function machine(label: string, agent?: AgentAdapter) {
  const homeDirectory = await scratch()
  const values = new Map<string, string>()
  const credentials = new MachineCredentialStore({
    get: (id) => values.get(id), set: (id, value) => { values.set(id, value) }, delete: (id) => values.delete(id),
  })
  const start = async (port = 0, advertisedHost?: string) => {
    const handle = await createProductionDaemonWithDependencies({ environment: {}, homeDirectory, machineLabel: label }, {
      ...productionDaemonDependencies,
      createProviderProbe: () => ({ inspect: async () => [] }),
      createMachineCredentials: () => credentials,
      createDaemon: (options) => new DomovoiDaemon({
        ...options, port, fleetHeartbeatIntervalMs: 50, fleetOperationTimeoutMs: 2_000,
        ...(advertisedHost ? { advertiseHost: advertisedHost } : {}),
        ...(agent ? { agents: { "claude-code": agent } } : {}),
      }),
    })
    daemons.push(handle)
    const address = await handle.start()
    const root = await connect(address.url)
    const workspace = workspaceSnapshotSchema.parse(await root.ok("system.hello", {
      client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: handle.authToken,
    }))
    return { handle, root, address, id: workspace.machine.id }
  }
  return { start, homeDirectory, credentials, ...await start() }
}

async function connect(url: string) {
  const socket = new WebSocket(url, { handshakeTimeout: 2_000 })
  sockets.push(socket)
  await once(socket, "open")
  const notifications: Array<{ method: string; params: unknown }> = []
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString()) as { id?: number; method: string; params: unknown }
    if (message.id === undefined) notifications.push(message)
  })
  let nextId = 0
  async function call<M extends RpcMethod>(method: M, params: RpcParams<M>) {
    const id = ++nextId
    return new Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off("message", receive); socket.off("close", closed) }
      const closed = () => { cleanup(); reject(new Error(`Socket closed during ${method}`)) }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`RPC test deadline: ${method}`)) }, 10_000)
      const receive = (bytes: WebSocket.RawData) => {
        const response = JSON.parse(bytes.toString()) as { id?: number; result?: unknown; error?: { code: number; message: string } }
        if (response.id === id) { cleanup(); resolve(response) }
      }
      socket.on("message", receive)
      socket.once("close", closed)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  return {
    socket, call, notifications,
    async ok<M extends RpcMethod>(method: M, params: RpcParams<M>) {
      const response = await call(method, params)
      expect(response.error, `RPC ${method}`).toBeUndefined()
      return rpcMethods[method].result.parse(response.result)
    },
  }
}

async function enroll(source: Awaited<ReturnType<typeof machine>>, target: Awaited<ReturnType<typeof machine>>) {
  const issued = await target.root.ok("device.issueCode", {}) as { code: string }
  const result = fleetEnrollResultSchema.parse(await source.root.ok("fleet.enroll", {
    endpoint: target.address.url, code: issued.code, sourceDeviceLabel: "source studio", expectedMachineId: target.id, client: "cli",
  }))
  expect(result.outcome).toBe("enrolled")
  return result
}

function remote(fleet: FleetSnapshot, id: string) {
  const row = fleet.entries.find((entry) => entry.kind === "machine" && entry.machine.id === id)
  if (row?.kind !== "machine") throw new Error("The enrolled machine has no row")
  return row.machine
}

function persistedRegistry<T>(homeDirectory: string, use: (registry: SqliteFleetRegistry) => T): T {
  const database = new DatabaseSync(join(homeDirectory, ".domovoi", "state.sqlite"))
  try { return use(new SqliteFleetRegistry(database)) }
  finally { database.close() }
}

describe("production fleet assembly", () => {
  it("explicitly refuses all rows on legacy index overflow, including the omitted count and a local recovery command", async () => {
    const source = await machine("source studio")
    for (let index = 0; index < 512; index += 1) {
      source.credentials.save(`machine-${index.toString(16).padStart(32, "0")}`, "n".repeat(43))
    }
    const reply = await source.root.call("fleet.list", {})
    expect(reply.result).toBeUndefined()
    expect(reply.error?.code).toBe(fleetSnapshotOverflowErrorCode)
    expect(fleetSnapshotOverflowSchema.parse(reply.error?.data)).toEqual({
      kind: "fleet-overflow", limit: 512, totalEntries: 513, entriesNotShown: 513,
    })
    expect(reply.error?.message).toContain("domovoid fleet-keychain list")
    expect(JSON.stringify(reply)).not.toContain("n".repeat(43))
  })

  it("refreshes an enrolled peer after restart and revocation without leaking fleet broadcasts to machines or unauthed sockets", async () => {
    const source = await machine("source studio")
    const target = await machine("target studio")
    const unauthed = await connect(source.address.url)
    const pairedClient = await connect(source.address.url)
    const paired = devicePairResultSchema.parse(await source.root.ok("device.pair", { label: "paired observer", client: "cli" }))
    await pairedClient.ok("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: paired.token })
    const observer = await connect(source.address.url)
    const machineCode = await source.root.ok("device.issueCode", {}) as { code: string }
    const machinePair = devicePairResultSchema.parse(await observer.ok("device.claim", {
      code: machineCode.code, label: "observer", machineId: `machine-${"e".repeat(32)}`, protocolVersion,
    }))
    await observer.ok("system.hello", { client: "machine", clientVersion: "0.0.1", protocolVersion, authToken: machinePair.token })

    // Paired client authority is not local root enrollment authority.
    expect((await pairedClient.call("fleet.enroll", { endpoint: target.address.url, code: "hearth-quiet-ember-42", sourceDeviceLabel: "paired observer", client: "cli" })).error?.code)
      .toBe(daemonAuthenticationErrorCode)
    expect((await pairedClient.call("fleet.forget", { machineId: target.id, client: "cli" })).error?.code)
      .toBe(daemonAuthenticationErrorCode)
    await enroll(source, target)
    await vi.waitFor(async () => {
      expect(pairedClient.notifications.some((notice) => notice.method === "fleet.changed"
        && fleetSnapshotSchema.parse(notice.params).entries.some((entry) => entry.kind === "machine" && entry.machine.id === target.id))).toBe(true)
    }, { timeout: 3_000 })

    const before = remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id)
    target.root.socket.close()
    await target.handle.stop()
    await vi.waitFor(async () => {
      expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id).health).toBe("reconnecting")
    }, { timeout: 3_000 })
    const failed = remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id)
    expect(Date.parse(failed.heartbeat.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(before.heartbeat.lastSeenAt))
    // Failure and mere relisting must never become fresh contact.
    expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id).heartbeat.lastSeenAt)
      .toBe(failed.heartbeat.lastSeenAt)
    const identityPath = join(target.homeDirectory, ".domovoi", "machine.json")
    const identity = JSON.parse(await readFile(identityPath, "utf8")) as { id: string; label: string }
    await writeFile(identityPath, JSON.stringify({ ...identity, label: "target renamed" }))
    const restarted = await target.start(target.address.port)
    const selfFacts = remote(fleetSnapshotSchema.parse(await restarted.root.ok("fleet.list", {})), target.id)
    await vi.waitFor(async () => {
      const refreshed = remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id)
      expect(refreshed).toMatchObject({ label: "target renamed", health: "healthy" })
      expect(refreshed.transports).toEqual(selfFacts.transports)
      expect(refreshed.verifiedRoute?.endpoint).toBe(target.address.url)
      expect(Date.parse(refreshed.heartbeat.lastSeenAt)).toBeGreaterThan(Date.parse(failed.heartbeat.lastSeenAt))
    }, { timeout: 3_000 })
    const deviceList = await restarted.root.ok("device.list", {}) as { devices: Array<{ id: string }> }
    await restarted.root.ok("device.revoke", { deviceId: deviceList.devices[0]!.id, client: "cli" })
    await vi.waitFor(async () => {
      expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id).health).toBe("pairing-required")
    }, { timeout: 3_000 })
    // Barrier replies on the same sockets prove all preceding broadcasts were
    // received; no timing sleep is used to assert an absence of leaked data.
    await observer.ok("fleet.heartbeat", {})
    await unauthed.call("workspace.get", {})
    expect(observer.notifications.filter((notice) => notice.method === "fleet.changed")).toEqual([])
    expect(unauthed.notifications.filter((notice) => notice.method === "fleet.changed")).toEqual([])
  })

  it.each(["normal", "overflow", "forgetting"] as const)("checks real transfer eligibility independently of fleet display: %s", async (scenario) => {
    const agent: AgentAdapter = {
      permissionCapabilities: { ask: "read-only", buildAuto: "pre-execution" },
      connect: async () => {}, close: async () => {},
      listModels: async () => [{ provider: "claude-code", id: "claude-opus-5", displayName: "Opus 5", description: "Test provider boundary", isDefault: true,
        supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }],
      startThread: async () => "provider-thread", stopThread: async () => {}, resumeThread: async () => {},
      startTurn: async () => "turn", steerTurn: async () => {}, interruptTurn: async () => {}, resolveApproval: () => {}, onEvent: () => () => {},
    }
    const source = await machine("source studio", agent)
    const target = await machine("target studio")
    const repository = join(await scratch(), "source")
    await mkdir(repository)
    const git = (cwd: string, args: string[]) => exec("git", args, { cwd, timeout: 10_000 })
    await git(repository, ["init", "-b", "main"])
    await git(repository, ["config", "user.name", "Domovoi Test"])
    await git(repository, ["config", "user.email", "test@example.invalid"])
    await git(repository, ["config", "core.autocrlf", "false"])
    await writeFile(join(repository, "README.md"), "initial\n")
    await git(repository, ["add", "README.md"])
    await git(repository, ["commit", "-m", "initial"])
    const targetRepository = join(await scratch(), "target")
    await git(repository, ["clone", "--no-local", repository, targetRepository])
    await git(targetRepository, ["config", "core.autocrlf", "false"])
    await target.root.ok("project.open", { path: targetRepository, client: "cli" })
    await source.root.ok("project.open", { path: repository, client: "cli" })
    const created = workspaceSnapshotSchema.parse(await source.root.ok("session.create", {
      title: "Fleet assembly session", client: "cli", runtime: { provider: "claude-code", model: "claude-opus-5", reasoning: "high", permissionMode: "build", auto: true },
    }))
    const session = created.sessions[0]!
    await writeFile(join(session.workspacePath!, "work.txt"), "uncommitted work travels\n")
    await source.root.ok("plan.edit", {
      sessionId: session.id, basedOnStructureRevision: 0, baseSteps: [], draftSteps: [{ text: "Check the transferred work" }], client: "cli",
    })
    const plan = workspaceSnapshotSchema.parse(await source.root.ok("workspace.get", {}))
    await enroll(source, target)
    if (scenario !== "normal") {
      for (let index = 0; index < maximumFleetEntries; index += 1) {
        source.credentials.save(`machine-${index.toString(16).padStart(32, "0")}`, "n".repeat(43))
      }
      expect((await source.root.call("fleet.list", {})).error?.code).toBe(fleetSnapshotOverflowErrorCode)
    }
    if (scenario === "forgetting") {
      // Retain both the known row and usable key while the lifecycle operation
      // is pending. A raw facts lookup would wrongly dial this peer again.
      vi.spyOn(source.credentials, "forget").mockImplementation(() => { throw new Error("keychain removal blocked") })
      const credential = source.credentials.forMachine(target.id)
      if (credential === undefined) throw new Error("Enrollment retained no credential")
      persistedRegistry(source.homeDirectory, (registry) => registry.stageForget(target.id, machineCredentialDigest(target.id, credential), Date.now()))
    }
    const request = { sessionId: session.id, targetMachineId: target.id, method: "git-bundle" as const, initiatedByClient: "cli" as const }
    const preview = rpcMethods["session.transferPreview"].result.parse(await source.root.ok("session.transferPreview", request))
    if (scenario === "forgetting") {
      expect(preview).toMatchObject({ allowed: false, reason: "target-unreachable" })
      expect(persistedRegistry(source.homeDirectory, (registry) => registry.pendingOperations()))
        .toContainEqual(expect.objectContaining({ machineId: target.id, kind: "forget" }))
      return
    }
    expect(preview.allowed).toBe(true)
    if (!preview.allowed) throw new Error(`Transfer preview refused: ${preview.reason}`)
    const moved = rpcMethods["session.transfer"].result.parse(await source.root.ok("session.transfer", {
      ...request, contractVersion: preview.contractVersion, intentDigest: preview.intentDigest,
    }))
    expect(moved.outcome).toBe("succeeded")
    if (moved.outcome !== "succeeded") throw new Error(`Transfer did not finish: ${JSON.stringify(moved)}`)
    expect(await readFile(join(moved.workspacePath, "work.txt"), "utf8")).toBe("uncommitted work travels\n")
    const arrived = workspaceSnapshotSchema.parse(await target.root.ok("workspace.get", {}))
    expect(arrived.sessions).toContainEqual(expect.objectContaining({ id: session.id, state: "idle", runtime: { ...session.runtime, auto: false },
      ownershipGeneration: moved.ownershipGeneration, transferredFrom: expect.objectContaining({ sourceMachineId: source.id, transferId: moved.transferId }) }))
    expect(arrived.workingPlans[0]?.steps).toEqual(plan.workingPlans[0]?.steps)
    expect(arrived.thread).toEqual(expect.arrayContaining(created.thread))
    const sourceAfter = workspaceSnapshotSchema.parse(await source.root.ok("workspace.get", {}))
    expect(sourceAfter.sessions[0]?.state).toBe("transferred")
    expect(await readFile(join(session.workspacePath!, "work.txt"), "utf8")).toBe("uncommitted work travels\n")
    expect((await source.root.call("session.send", { sessionId: session.id, prompt: "must not run", client: "cli" })).error).toBeDefined()
  }, 30_000)
})
