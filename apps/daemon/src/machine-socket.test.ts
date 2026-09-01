import { once } from "node:events"

import { WebSocketServer } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { openMachineSocket } from "./machine-socket.js"

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function machineServer(handler: (message: Record<string, unknown>) => unknown) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  servers.push(server)
  await once(server, "listening")
  const seen: Record<string, unknown>[] = []
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      seen.push(message)
      const result = handler(message)
      if (result === undefined) return
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    })
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { seen, endpoint: `ws://127.0.0.1:${port}/rpc` }
}

describe("openMachineSocket", () => {
  it("says hello with the credential before anything else", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return { machine: { id: "machine-x" } }
      return { state: "receiving" }
    })

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
    })
    await connection.call("transfer.begin", { sessionId: "session-1" })
    connection.close()

    expect(machine.seen[0]).toMatchObject({
      method: "system.hello",
      params: { authToken: "n".repeat(43) },
    })
    expect(machine.seen[1]).toMatchObject({ method: "transfer.begin" })
  })

  it("answers each call with the reply that carries its id", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return { machine: { id: "machine-x" } }
      return { echoed: message.id }
    })

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
    })
    const [first, second] = await Promise.all([
      connection.call("transfer.chunk", { sequence: 0 }),
      connection.call("transfer.chunk", { sequence: 1 }),
    ])
    connection.close()

    expect(first).not.toEqual(second)
  })

  it("fails a call the machine refuses, in the machine's words", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method?: string }
        if (message.method === "system.hello") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { machine: {} } }))
          return
        }
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "That transfer is not arriving" },
        }))
      })
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const connection = await openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
    })

    await expect(connection.call("transfer.chunk", {}))
      .rejects.toThrow("That transfer is not arriving")
    connection.close()
  })

  it("fails every pending call when the machine hangs up", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method?: string }
        if (message.method === "system.hello") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { machine: {} } }))
          return
        }
        socket.close()
      })
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const connection = await openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
    })

    await expect(connection.call("transfer.chunk", {}))
      .rejects.toThrow("The machine closed the connection")
  })

  it("gives up on a machine that never answers the handshake", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    await expect(openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
      handshakeTimeoutMs: 200,
    })).rejects.toThrow("That machine did not answer")
  })
})
