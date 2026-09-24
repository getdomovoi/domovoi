import { once } from "node:events"

import { deviceIssueCodeResultSchema, protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

// A pairing code is spent at an address. The daemon that issues the code says
// which, or why there is none, so the desktop card and the web page draw the
// same address the command line does, and none of them works it out alone.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

let nextId = 1
async function owner(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(3_000) })
  const call = (method: string, params: Record<string, unknown>) => {
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
  expect(await call("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).not.toHaveProperty("error")
  return call
}

describe("the address an issued pairing code names", () => {
  it("is the loopback listener itself, marked as reaching only this machine", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const call = await owner(daemon)
    const issued = deviceIssueCodeResultSchema.parse((await call("device.issueCode", { targetClient: "phone" })).result)
    expect(issued.pairingAddress).toEqual({ url: `ws://127.0.0.1:${port}/rpc`, loopback: true })
  })

  it("is a problem when the listener is one a device cannot verify", async () => {
    const daemon = new DomovoiDaemon({ port: 0, host: "0.0.0.0", allowRemoteTransport: true, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const call = await owner(daemon)
    const issued = deviceIssueCodeResultSchema.parse((await call("device.issueCode", { targetClient: "phone" })).result)
    expect(issued.pairingAddress).toEqual({ problem: expect.stringContaining("serves no certificate") })
    // The code itself is still issued: the problem is the address, not the pairing.
    expect(issued.code).toMatch(/\w+-\w+/)
  })
})
