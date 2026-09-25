import { once } from "node:events"

import { afterEach, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { DomovoiDaemon } from "./server.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

it("refuses a noncanonical redeem version as a bad request, not an internal error", async () => {
  const errorSink = vi.fn()
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", errorSink, agents: {} })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const reply = new Promise<{ id?: unknown; error?: { code: number; message: string } }>((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as { id?: unknown; error?: { code: number; message: string } }))
  })
  socket.send(JSON.stringify({
    jsonrpc: "2.0", id: 7, method: "device.redeemCode",
    params: { code: daemon.issuePairingCode().code, label: "phone", protocolVersion: "01.8.0" },
  }))
  const answered = await reply
  expect(answered.id).toBe(7)
  expect(answered.error?.code).toBe(-32602)
  expect(errorSink).not.toHaveBeenCalledWith(expect.objectContaining({ context: "RPC dispatch failed" }))
})
