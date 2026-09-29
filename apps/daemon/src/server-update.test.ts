import { once } from "node:events"
import { networkInterfaces } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { daemonAuthenticationErrorCode, localOwnerRequiredErrorCode, protocolVersion, updateStatusSchema } from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
let nextId = 0

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

function call(socket: WebSocket, method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId
  return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No reply to ${method}`)) }, 2_000)
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage) }
    const onMessage = (bytes: WebSocket.RawData) => {
      const response = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { code: number; message: string } }
      if (response.id === id) { cleanup(); resolve(response) }
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function start() {
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
  daemons.push(daemon)
  const address = await daemon.start()
  const connect = async (token: string, client: "cli" | "machine" = "cli") => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
    sockets.push(socket)
    await once(socket, "open")
    expect((await call(socket, "system.hello", { client, clientVersion: "0.0.1", protocolVersion, authToken: token })).error).toBeUndefined()
    return socket
  }
  return { daemon, connect, socket: await connect(daemon.authToken) }
}

describe("daemon update dispatch", () => {
  it("reports idle and bounded policy refusals when updates are not configured", async () => {
    const { socket } = await start()
    const status = updateStatusSchema.parse((await call(socket, "update.status")).result)
    expect(status).toMatchObject({ state: "idle", channel: "stable", currentVersion: "0.0.1" })
    for (const method of ["update.check", "update.activate"]) {
      expect(updateStatusSchema.parse((await call(socket, method)).result)).toMatchObject({ state: "failed", refusal: { reason: "policy" } })
    }
  })

  // The refusal is a policy line, not a credential failure. A client that
  // reads the authentication code drops the connection and marks the machine
  // as no longer accepting it (Q169), so the refusal carries its own code and
  // the connection stays usable.
  const refusal = { code: localOwnerRequiredErrorCode, message: "Updates require a loopback local-owner connection" }

  it("refuses paired clients on every update method without an authentication error", async () => {
    const { socket, connect } = await start()
    const paired = (await call(socket, "device.pair", { label: "paired cli", client: "cli" })).result as { token: string }
    const client = await connect(paired.token)
    for (const method of ["update.status", "update.check", "update.activate"]) {
      const { error } = await call(client, method)
      expect(error).toEqual(refusal)
      expect(error?.code).not.toBe(daemonAuthenticationErrorCode)
    }
    expect((await call(client, "workspace.get")).error).toBeUndefined()
    expect(client.readyState).toBe(WebSocket.OPEN)
  })

  // Machine connections meet the machine lifecycle boundary before the update
  // check, and that boundary is out of this refusal's scope.
  it("refuses paired machine callers on every update method", async () => {
    const { daemon, socket, connect } = await start()
    const machineId = `machine-${"e".repeat(32)}`
    const pending = (await call(socket, "device.claim", {
      code: daemon.issuePairingCode().code, label: "peer", machineId, protocolVersion,
    })).result as { token: string }
    expect((await call(socket, "device.confirmClaim", { authToken: pending.token, machineId, protocolVersion })).error).toBeUndefined()
    const machine = await connect(pending.token, "machine")
    for (const method of ["update.status", "update.check", "update.activate"]) {
      expect((await call(machine, method)).error?.code).toBe(daemonAuthenticationErrorCode)
    }
  })

  // The daemon bearer itself, from an address that is not loopback: only the
  // peer address fails the check.
  const remoteAddress = Object.values(networkInterfaces()).flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address
  it.skipIf(remoteAddress === undefined)("refuses the daemon credential from a non-loopback peer without an authentication error", async () => {
    const daemon = new DomovoiDaemon({ port: 0, host: "0.0.0.0", allowRemoteTransport: true, statePath: ":memory:" })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const socket = new WebSocket(`ws://${remoteAddress}:${port}/rpc`)
    sockets.push(socket)
    await once(socket, "open")
    expect((await call(socket, "system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).error).toBeUndefined()
    for (const method of ["update.status", "update.check", "update.activate"]) {
      expect((await call(socket, method)).error).toEqual(refusal)
    }
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })
})
