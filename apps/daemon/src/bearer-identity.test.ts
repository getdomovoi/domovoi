import { once } from "node:events"

import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

// The daemon bearer can be read by any process of the owner's user. Whoever
// holds it must not be able to act under a paired device's name.

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
})
