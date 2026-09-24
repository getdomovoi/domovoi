import { once } from "node:events"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, rpcMethods } from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const roots: string[] = []
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
let nextId = 0

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  const stops = await Promise.allSettled(daemons.splice(0).map((daemon) => daemon.stop()))
  const failures = stops.flatMap((stop) => stop.status === "rejected" ? [stop.reason] : [])
  try { await removeScratchDirectories(roots) } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, "Cleanup failed")
})

async function damagedState(): Promise<{ statePath: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "domovoi-state-recovery-"))
  roots.push(root)
  const statePath = join(root, "state.sqlite")
  const seed = new SqliteWorkspaceStore(statePath, demoWorkspace)
  const paired = seed.devices.pair({ label: "studio-phone", binding: { kind: "client", client: "phone" } })
  await seed.close()
  const database = new DatabaseSync(statePath)
  try {
    database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1")
      .run(JSON.stringify({ ...demoWorkspace, sessions: "not sessions" }))
  } finally { database.close() }
  return { statePath, token: paired.token }
}

function hello(socket: WebSocket, params: Record<string, unknown>) {
  const id = ++nextId
  return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("No test reply to system.hello")) }, 5_000)
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage) }
    const onMessage = (bytes: WebSocket.RawData) => {
      const response = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { code: number; message: string } }
      if (response.id === id) { cleanup(); resolve(response) }
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "system.hello", params }))
  })
}

async function open(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  return socket
}

describe("stored state recovery", () => {
  it("tells the owner which file was moved aside and a paired phone only what survived", async () => {
    const { statePath, token } = await damagedState()
    const errorSink = vi.fn()
    const daemon = new DomovoiDaemon({ port: 0, statePath, errorSink, agents: {} })
    daemons.push(daemon)
    const { port } = await daemon.start()

    const expected = {
      kind: "snapshot",
      quarantinedPath: expect.stringMatching(/state\.sqlite\.snapshot-corrupt-[0-9TZ-]+\.json$/),
      reason: expect.stringContaining("ZodError"),
      occurredAt: expect.any(String),
      pairedDevicesKept: true,
      workspaceKept: false,
    }
    const desktop = await hello(await open(port), {
      client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })
    expect(desktop.error).toBeUndefined()
    const desktopHello = rpcMethods["system.hello"].result.parse(desktop.result)
    expect(desktopHello.stateRecovery).toEqual(expected)
    expect(await readFile(desktopHello.stateRecovery!.quarantinedPath!, "utf8")).toContain("not sessions")

    const phone = await hello(await open(port), {
      client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: token,
    })
    expect(phone.error).toBeUndefined()
    expect(rpcMethods["system.hello"].result.parse(phone.result).stateRecovery).toEqual({
      kind: "snapshot",
      occurredAt: desktopHello.stateRecovery!.occurredAt,
      pairedDevicesKept: true,
      workspaceKept: false,
    })

    expect(errorSink).toHaveBeenCalledWith({
      context: "Domovoi moved unreadable stored state aside",
      detail: expect.stringContaining("state.sqlite.snapshot-corrupt-"),
    })
  })
})
