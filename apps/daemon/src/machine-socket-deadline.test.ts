import { once } from "node:events"
import { createServer, type Server, type Socket } from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import { openMachineSocket } from "./machine-socket.js"
import { OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"

const servers: Server[] = []
const sockets: Socket[] = []
const deadlines: OperationDeadline[] = []
afterEach(async () => {
  for (const deadline of deadlines.splice(0)) deadline.clear()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

function deadline() {
  let expire: (() => void) | undefined
  const clock = OperationDeadline.start(1_000, {
    now: () => 0,
    scheduler: { setTimeout: (callback) => { expire ??= callback; return 1 }, clearTimeout: () => {} },
  })
  deadlines.push(clock)
  return { clock, expire: () => expire!() }
}

async function silentTcpListener() {
  const server = createServer((socket) => { sockets.push(socket); socket.resume() })
  servers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  return { server, input: {
    endpoint: `ws://127.0.0.1:${address.port}/rpc`, expectedMachineId: `machine-${"a".repeat(32)}`,
    credential: "n".repeat(43), callTimeoutMs: 1_000,
  } }
}

describe("machine socket establishment deadline", () => {
  it("bounds a listener that accepts TCP and never completes WebSocket upgrade, then closes it", async () => {
    const listener = await silentTcpListener()
    const budget = deadline()
    const accepted = once(listener.server, "connection")
    const opening = openMachineSocket({ ...listener.input, deadline: budget.clock })
    const refusal = expect(opening).rejects.toThrow("That machine did not answer before the deadline")
    const [remoteSocket] = await accepted as [Socket]
    const closed = once(remoteSocket, "close")
    budget.expire()
    await refusal
    await closed
    expect(remoteSocket.destroyed).toBe(true)
  })

  it("never allocates a connection after its operation already expired", async () => {
    const listener = await silentTcpListener()
    const budget = deadline()
    let connections = 0
    listener.server.on("connection", () => { connections += 1 })
    budget.expire()
    await expect(openMachineSocket({ ...listener.input, deadline: budget.clock }))
      .rejects.toBeInstanceOf(OperationDeadlineExceededError)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(connections).toBe(0)
  })
})
