import { once } from "node:events"

import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

// The daemon bearer can be read by any process of the owner's user. Whoever
// holds it must not be able to act under a paired device's name, and the audit
// log says which credential a client connected with.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

let nextId = 1

async function connect(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  return (method: string, params: Record<string, unknown>) => {
    const id = nextId++
    return new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
}

const hello = (client: string, clientId: string, authToken: string) =>
  ({ client, clientId, clientVersion: "0.0.1", protocolVersion, authToken })

describe("daemon bearer identity", () => {
  it("refuses a daemon-bearer connection that claims a paired device's id", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await connect(daemon)
    expect(await owner("system.hello", hello("cli", "cli-owner", daemon.authToken))).not.toHaveProperty("error")
    const minted = await owner("device.pair", { label: "iPhone", client: "cli", targetClient: "phone" })
    const deviceId = (minted.result as { device: { id: string } }).device.id

    const impostor = await connect(daemon)
    const refused = await impostor("system.hello", hello("phone", deviceId, daemon.authToken))

    expect(refused).toMatchObject({ error: { message: expect.stringContaining("paired device") } })
  })

  it("records the daemon credential on actions a bearer connection takes, and the device credential on a paired one", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await connect(daemon)
    expect(await owner("system.hello", hello("cli", "cli-owner", daemon.authToken))).not.toHaveProperty("error")
    const minted = await owner("device.pair", { label: "iPhone", client: "cli", targetClient: "phone" })
    const { token } = minted.result as { token: string }
    const phone = await connect(daemon)
    expect(await phone("system.hello", hello("phone", "ignored", token))).not.toHaveProperty("error")
    await phone("session.stop", { sessionId: "no-such-session", client: "phone" })

    const exported = await owner("audit.export", {})
    const lines = (exported.result as { content: string }).content.trim().split("\n")
    const actors = lines.map((line) => (JSON.parse(line) as { actor: Record<string, unknown> }).actor)

    expect(actors).toContainEqual(expect.objectContaining({ kind: "client", client: "cli", credential: "daemon" }))
    expect(actors).toContainEqual(expect.objectContaining({ kind: "client", client: "phone", credential: "device" }))
  })
})
