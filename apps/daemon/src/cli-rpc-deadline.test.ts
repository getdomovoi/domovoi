import { once } from "node:events"
import { createServer, type Server, type Socket } from "node:net"

import { WebSocketServer, type WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { protocolVersion } from "@getdomovoi/protocol"

import { callDaemonOnce, CliDeadlineError } from "./cli-rpc.js"
import { OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"

const tcpServers: Server[] = []
const tcpSockets: Socket[] = []
const wsServers: WebSocketServer[] = []
const wsPeers: WebSocket[] = []
const deadlines: OperationDeadline[] = []

afterEach(async () => {
  for (const deadline of deadlines.splice(0)) deadline.clear()
  for (const socket of tcpSockets.splice(0)) socket.destroy()
  for (const peer of wsPeers.splice(0)) peer.terminate()
  for (const server of tcpServers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const server of wsServers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

const token = "t".repeat(43)

function deadline() {
  let expire: (() => void) | undefined
  const clock = OperationDeadline.start(1_000, {
    now: () => 0,
    scheduler: { setTimeout: (callback) => { expire ??= callback; return 1 }, clearTimeout: () => {} },
  })
  deadlines.push(clock)
  return { clock, expire: () => expire!() }
}

// A listener that accepts the TCP connection and never answers the upgrade.
async function silentTcpListener() {
  const server = createServer((socket) => { tcpSockets.push(socket); socket.resume() })
  tcpServers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as { port: number }
  return { server, target: { host: "127.0.0.1", port } }
}

// A listener that completes the WebSocket upgrade and then answers nothing
// beyond the methods it is told to answer.
async function silentWebSocketListener(answers: readonly string[]) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  wsServers.push(server)
  await once(server, "listening")
  const heard = new Set<string>()
  const waiting = new Map<string, () => void>()
  const waitFor = (method: string) => heard.has(method)
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiting.set(method, resolve) })
  server.on("connection", (peer) => {
    wsPeers.push(peer)
    peer.on("message", (data: { toString(): string }) => {
      const message = JSON.parse(data.toString()) as { id: number; method: string }
      if (answers.includes(message.method)) {
        peer.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: message.method === "system.hello" ? { protocolVersion } : { code: "123456" },
        }))
      }
      heard.add(message.method)
      waiting.get(message.method)?.()
    })
  })
  const { port } = server.address() as { port: number }
  return { server, target: { host: "127.0.0.1", port }, waitFor }
}

const issueCode = { method: "device.issueCode", params: {} }

describe("one-shot CLI command deadline", () => {
  it("refuses a listener that accepts the connection and never completes the upgrade", async () => {
    const listener = await silentTcpListener()
    const budget = deadline()
    const accepted = once(listener.server, "connection")
    const calling = callDaemonOnce({ ...issueCode, target: listener.target, token, deadline: budget.clock })
    const refused = expect(calling).rejects.toThrow(
      `The daemon at ws://127.0.0.1:${listener.target.port}/rpc did not accept the connection before the deadline.`
      + " Check that domovoid is running at that address, then run this command again.",
    )
    const [peer] = await accepted as [Socket]
    const closed = once(peer, "close")
    budget.expire()
    await refused
    await closed
    expect(peer.destroyed).toBe(true)
  })

  it("refuses a peer that accepts the connection and never answers the handshake", async () => {
    const listener = await silentWebSocketListener([])
    const budget = deadline()
    const calling = callDaemonOnce({ ...issueCode, target: listener.target, token, deadline: budget.clock })
    const refused = expect(calling).rejects.toThrow(
      `The daemon at ws://127.0.0.1:${listener.target.port}/rpc did not answer system.hello before the deadline.`
      + " Check that domovoid is running at that address, then run this command again.",
    )
    await listener.waitFor("system.hello")
    const closed = once(wsPeers[0]!, "close")
    budget.expire()
    await refused
    await closed
  })

  it("refuses a peer that completes the handshake and then stalls mid-call", async () => {
    const listener = await silentWebSocketListener(["system.hello"])
    const budget = deadline()
    const calling = callDaemonOnce({ ...issueCode, target: listener.target, token, deadline: budget.clock })
    const refused = expect(calling).rejects.toThrow(
      `The daemon at ws://127.0.0.1:${listener.target.port}/rpc did not answer device.issueCode before the deadline.`
      + " Check that domovoid is running at that address, then run this command again.",
    )
    await listener.waitFor("device.issueCode")
    const closed = once(wsPeers[0]!, "close")
    budget.expire()
    await refused
    await closed
  })

  it("never allocates a connection after its command already expired", async () => {
    const listener = await silentTcpListener()
    const budget = deadline()
    let connections = 0
    listener.server.on("connection", () => { connections += 1 })
    budget.expire()
    await expect(callDaemonOnce({ ...issueCode, target: listener.target, token, deadline: budget.clock }))
      .rejects.toBeInstanceOf(OperationDeadlineExceededError)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(connections).toBe(0)
  })

  it("returns the answered result inside the budget without naming the token", async () => {
    const listener = await silentWebSocketListener(["system.hello", "device.issueCode"])
    const budget = deadline()
    await expect(callDaemonOnce({ ...issueCode, target: listener.target, token, deadline: budget.clock }))
      .resolves.toEqual({ code: "123456" })
  })

  it("names the address without the bearer token when a hand-typed host stalls", async () => {
    const listener = await silentTcpListener()
    const budget = deadline()
    const calling = callDaemonOnce({ ...issueCode, target: listener.target, token, deadline: budget.clock })
    const refused = calling.catch((error: Error) => error)
    await once(listener.server, "connection")
    budget.expire()
    const error = await refused
    expect(error).toBeInstanceOf(CliDeadlineError)
    expect((error as Error).message).not.toContain(token)
  })
})
