import { once } from "node:events"

import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"

import { connectToDaemon } from "./rpc.js"

const servers: WebSocketServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise((settle) => server.close(settle))
  }
})

async function fakeDaemon(onMessage: (socket: WebSocket, message: { id: number; method: string }) => void) {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  await once(server, "listening")
  server.on("connection", (socket) => {
    socket.on("message", (data) => onMessage(socket, JSON.parse(data.toString()) as { id: number; method: string }))
  })
  const { port } = server.address() as { port: number }
  return { server, endpoint: `ws://127.0.0.1:${port}/rpc` }
}

describe("connectToDaemon", () => {
  it("terminates its socket when the hello is refused, so the process can exit", async () => {
    const { server, endpoint } = await fakeDaemon((socket, message) => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Daemon authentication failed" } }))
    })
    await expect(connectToDaemon({ endpoint, authToken: "x".repeat(43), timeoutMs: 2_000 })).rejects.toThrow(/authentication failed/)
    await new Promise((settle) => setTimeout(settle, 50))
    expect([...server.clients].filter((client) => client.readyState === client.OPEN)).toHaveLength(0)
  })

  it("terminates its socket when the hello never answers", async () => {
    const { server, endpoint } = await fakeDaemon(() => {})
    await expect(connectToDaemon({ endpoint, timeoutMs: 200 })).rejects.toThrow(/did not answer system\.hello/)
    await new Promise((settle) => setTimeout(settle, 50))
    expect([...server.clients].filter((client) => client.readyState === client.OPEN)).toHaveLength(0)
  })

  it("ignores a frame that is valid JSON but not an envelope", async () => {
    const { endpoint } = await fakeDaemon((socket, message) => {
      socket.send("null")
      socket.send("42")
      socket.send(JSON.stringify([]))
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }))
    })
    const connection = await connectToDaemon({ endpoint, timeoutMs: 2_000 })
    await expect(connection.call("workspace.get", {})).resolves.toEqual({})
    connection.close()
  })
})
