import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"

import {
  fleetEnrollResultSchema, protocolVersion, rpcMethods, workspaceSnapshotSchema,
  type FleetSnapshot, type RpcMethod, type RpcParams,
} from "@getdomovoi/protocol"
import { expect } from "vitest"
import { WebSocket, type ClientOptions } from "ws"

import type { AgentAdapter } from "./agents.js"
import type { DaemonEnvironment } from "./config.js"
import { MachineCredentialStore } from "./machine-credentials.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import { SqliteFleetRegistry } from "./fleet-registry.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies, type ProductionDaemonHandle } from "./production-daemon.js"
import { removeScratchDirectories } from "./test-scratch.js"

const exec = promisify(execFile)

export const git = (cwd: string, args: string[]) => exec("git", args, { cwd, timeout: 10_000 })

export type FleetDaemonStart = {
  port?: number
  advertisedHost?: string
  // Stands in for another daemon release; see DaemonServerOptions.
  protocolVersion?: string
  environment?: DaemonEnvironment
  clientOptions?: ClientOptions
}

// A provider boundary that can create a session without any real agent.
export const sessionAgent: AgentAdapter = {
  permissionCapabilities: { ask: "read-only", buildAuto: "pre-execution" },
  connect: async () => {}, close: async () => {},
  listModels: async () => [{ provider: "claude-code", id: "claude-opus-5", displayName: "Opus 5", description: "Test provider boundary", isDefault: true,
    supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }],
  startThread: async () => "provider-thread", stopThread: async () => {}, resumeThread: async () => {},
  startTurn: async () => "turn", steerTurn: async () => {}, interruptTurn: async () => {}, resolveApproval: () => {}, onEvent: () => () => {},
}

export function remote(fleet: FleetSnapshot, id: string) {
  const row = fleet.entries.find((entry) => entry.kind === "machine" && entry.machine.id === id)
  if (row?.kind !== "machine") throw new Error("The enrolled machine has no row")
  return row.machine
}

export function persistedRegistry<T>(homeDirectory: string, use: (registry: SqliteFleetRegistry) => T): T {
  const database = new DatabaseSync(join(homeDirectory, ".domovoi", "state.sqlite"))
  try { return use(new SqliteFleetRegistry(database)) }
  finally { database.close() }
}

// Two production-built daemons over real sockets, SQLite and Git. Only
// external platform/provider dependencies are substituted. Identity, SQLite,
// Git, enrollment, timers, routing and every RPC use production code.
export function fleetProductionHarness() {
  const roots: string[] = []
  const daemons: ProductionDaemonHandle[] = []
  const sockets: WebSocket[] = []

  async function cleanup() {
    for (const socket of sockets.splice(0)) socket.terminate()
    for (const daemon of daemons.splice(0)) await daemon.stop()
    await removeScratchDirectories(roots.splice(0))
  }

  async function scratch() {
    const path = await mkdtemp(join(tmpdir(), "domovoi-fleet-production-"))
    roots.push(path)
    return path
  }

  async function repository(name: string) {
    const path = join(await scratch(), name)
    await mkdir(path)
    await git(path, ["init", "-b", "main"])
    await git(path, ["config", "user.name", "Domovoi Test"])
    await git(path, ["config", "user.email", "test@example.invalid"])
    await git(path, ["config", "core.autocrlf", "false"])
    await writeFile(join(path, "README.md"), "initial\n")
    await git(path, ["add", "README.md"])
    await git(path, ["commit", "-m", "initial"])
    return path
  }

  async function connect(url: string, options: ClientOptions = {}) {
    const socket = new WebSocket(url, { ...options, handshakeTimeout: 2_000 })
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

  async function machine(label: string, agent?: AgentAdapter, initialStart: FleetDaemonStart = {}) {
    const homeDirectory = await scratch()
    const values = new Map<string, string>()
    const credentials = new MachineCredentialStore({
      get: (id) => values.get(id), set: (id, value) => { values.set(id, value) }, delete: (id) => values.delete(id),
    })
    const start = async ({ port = 0, advertisedHost, protocolVersion: advertisedProtocolVersion, environment = {}, clientOptions }: FleetDaemonStart = {}) => {
      const handle = await createProductionDaemonWithDependencies({ environment, homeDirectory, machineLabel: label }, {
        ...productionDaemonDependencies,
        createProviderProbe: () => ({ inspect: async () => [] }),
        createMachineCredentials: () => asyncTestCredentials(credentials),
        // The production dependency builds the daemon; only its tuning changes.
        createDaemon: (options) => productionDaemonDependencies.createDaemon({
          ...options, port, fleetHeartbeatIntervalMs: 50, fleetOperationTimeoutMs: 2_000,
          ...(advertisedHost ? { advertiseHost: advertisedHost } : {}),
          ...(advertisedProtocolVersion ? { advertisedProtocolVersion } : {}),
          ...(agent ? { agents: { "claude-code": agent } } : {}),
        }),
      })
      daemons.push(handle)
      const address = await handle.start()
      const root = await connect(address.url, clientOptions)
      const workspace = workspaceSnapshotSchema.parse(await root.ok("system.hello", {
        client: "cli", clientVersion: "0.0.1", protocolVersion: advertisedProtocolVersion ?? protocolVersion, authToken: handle.authToken,
      }))
      return { handle, root, address, id: workspace.machine.id }
    }
    return { start, homeDirectory, credentials, ...await start(initialStart) }
  }

  async function enroll(source: Awaited<ReturnType<typeof machine>>, target: Awaited<ReturnType<typeof machine>>) {
    const issued = await target.root.ok("device.issueCode", {}) as { code: string }
    const result = fleetEnrollResultSchema.parse(await source.root.ok("fleet.enroll", {
      endpoint: target.address.url, code: issued.code, sourceDeviceLabel: "source studio", expectedMachineId: target.id, client: "cli",
    }))
    expect(result.outcome).toBe("enrolled")
    return result
  }

  return { cleanup, scratch, repository, connect, machine, enroll }
}

export type FleetDaemon = Awaited<ReturnType<ReturnType<typeof fleetProductionHarness>["machine"]>>
