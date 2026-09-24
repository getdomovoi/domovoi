import { once } from "node:events"

import { afterEach, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import { rpcMethods } from "@getdomovoi/protocol"

import { callDaemon, readDaemonResult } from "./cli-rpc.js"

const servers: WebSocketServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function daemonThatAnswers(reply: (request: { id: number; method: string }) => string[]) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/rpc" })
  servers.push(server)
  await once(server, "listening")
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: number; method: string }
      for (const frame of reply(request)) socket.send(frame)
    })
  })
  return (server.address() as { port: number }).port
}

it("ignores frames that are not JSON-RPC replies and reads the one that is", async () => {
  const port = await daemonThatAnswers((request) => [
    "null",
    "[1, 2]",
    "42",
    JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "system.hello" ? {} : { ok: true } }),
  ])
  await expect(callDaemon({ target: { host: "127.0.0.1", port }, token: "t", method: "device.list", params: {} }))
    .resolves.toEqual({ ok: true })
})

it("does not repeat a refusal whose message is not text", async () => {
  const port = await daemonThatAnswers((request) => [
    request.method === "system.hello"
      ? JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })
      : JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: { quoted: "anything" } } }),
  ])
  await expect(callDaemon({ target: { host: "127.0.0.1", port }, token: "t", method: "device.list", params: {} }))
    .rejects.toThrow("The daemon refused device.list")
})

// A reply that parses as JSON-RPC but whose result is not the method's shape
// is refused the way a malformed reply is, not thrown as the schema's error.
it("refuses a result that is not its method's shape, in the refusal's own words", () => {
  const schema = rpcMethods["device.issueCode"].result
  expect(readDaemonResult("device.issueCode", schema, { code: "hearth-quiet-ember-42", expiresAt: "2026-08-31T12:03:00.000Z" }))
    .toEqual({ code: "hearth-quiet-ember-42", expiresAt: "2026-08-31T12:03:00.000Z" })
  let refusal: unknown
  try { readDaemonResult("device.issueCode", schema, { code: 42 }) } catch (error) { refusal = error }
  expect(refusal).toBeInstanceOf(Error)
  expect((refusal as Error).constructor).toBe(Error)
  expect((refusal as Error).message).toBe("The daemon refused device.issueCode")
})
