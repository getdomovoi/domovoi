import { once } from "node:events"

import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

// Ruled 2026-09-23: a wire change is a minor bump. A client still on 0.8 is
// refused at hello with the mismatch it can explain, rather than failing to
// parse a result that grew a field.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

async function hello(daemon: DomovoiDaemon, clientProtocolVersion: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.address!.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const reply = once(socket, "message")
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: {
    client: "desktop", clientId: "desktop-version", clientVersion: "0.0.1", protocolVersion: clientProtocolVersion, authToken: daemon.authToken,
  } }))
  return JSON.parse(String((await reply)[0])) as Record<string, unknown>
}

describe("protocol 0.9 admission", () => {
  it("refuses a 0.8 client with protocol-mismatch and admits 0.9 at any patch", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    for (const old of ["0.8.0", "0.8.9"]) {
      expect(await hello(daemon, old), old).toMatchObject({ error: { code: -32012, data: {
        kind: "protocol-mismatch", daemonProtocolVersion: "0.9.0", clientProtocolVersion: old, compatibility: "machine-ahead",
      } } })
    }
    for (const current of ["0.9.0", "0.9.4"]) expect(await hello(daemon, current), current).not.toHaveProperty("error")
  })
})
