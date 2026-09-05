import { asyncTestCredentials } from "./test-machine-credentials.js"
import { once } from "node:events"

import { createEmptyWorkspace, demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"

import { createMachineDialer } from "./machine-dial.js"
import { openMachineSocket } from "./machine-socket.js"
import { OperationDeadline } from "./operation-deadline.js"

// Count actual constructor calls while keeping the real WebSocket handshake.
vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>()
  return { ...actual, WebSocket: Object.assign(vi.fn(function (...args: ConstructorParameters<typeof actual.WebSocket>) {
    return new actual.WebSocket(...args)
  }), actual.WebSocket) }
})

const machineId = `machine-${"b".repeat(32)}`
const credential = "n".repeat(43)
const servers: WebSocketServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate()
    const closed = once(server, "close", { signal: AbortSignal.timeout(2_000) })
    server.close()
    await closed
  }
  vi.clearAllMocks()
})

async function listeningMachine(host: string) {
  const server = new WebSocketServer({ host, port: 0 })
  servers.push(server)
  await once(server, "listening", { signal: AbortSignal.timeout(2_000) })
  const seen: unknown[] = []
  server.on("connection", (socket) => socket.on("message", (data) => {
    const request = JSON.parse(data.toString()) as { id: number }
    seen.push(request)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: createEmptyWorkspace({ ...demoWorkspace.machine, id: machineId }),
    }))
  }))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No listening machine address")
  return { port: address.port, seen }
}

async function open(endpoint: string, route: "socket" | "advertised" | "verified") {
  const deadline = OperationDeadline.start(2_000)
  const connect = (input: Parameters<typeof openMachineSocket>[0]) => openMachineSocket(input)
  try {
    if (route === "socket") return await connect({ endpoint, expectedMachineId: machineId, credential, deadline, callTimeoutMs: 2_000 })
    const dial = createMachineDialer({
      machine: () => ({ id: machineId, connection: route === "verified" ? "direct" : "local",
        transports: route === "verified" ? [] : [{ kind: "local", endpoint, authenticated: true }],
        ...(route === "verified" ? { verifiedRoute: { endpoint, lastAuthenticatedAt: new Date(0).toISOString() } } : {}),
      }),
      credentials: asyncTestCredentials({ machines: () => [machineId], forMachine: () => credential, save: () => {}, forget: () => {} }),
      dialTimeoutMs: 2_000,
      open: (input) => connect({ ...input, callTimeoutMs: 2_000 }),
    })
    return await dial(machineId, undefined, deadline)
  } finally { deadline.clear() }
}

describe.each(["socket", "advertised", "verified"] as const)("machine endpoint guard on %s route", (route) => {
  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["127%2e0%2e0%2e1", "127.0.0.1"],
    ["[::1]", "::1"],
    ["[0:0:0:0:0:0:0:1]", "::1"],
  ])("authenticates normalized loopback %s", async (host, bind) => {
    const target = await listeningMachine(bind)
    const connection = await open(`ws://${host}:${target.port}/rpc`, route)
    try {
      expect(WebSocket).toHaveBeenCalledOnce()
      expect(target.seen).toEqual([expect.objectContaining({ method: "system.hello", params: expect.objectContaining({ authToken: credential }) })])
    } finally { connection.close() }
  })

  it.each(["[::ffff:127.0.0.1]", "127.0.0.1%2eexample.com"])("rejects %s before constructing any socket", async (host) => {
    const constructor = vi.mocked(WebSocket).getMockImplementation()!
    // A guard regression must fail this assertion without dialing a real host.
    vi.mocked(WebSocket).mockImplementation(function () { throw new Error("Unexpected socket construction") })
    try {
      await expect(open(`ws://${host}:47831/rpc`, route)).rejects.toThrow()
      expect(WebSocket).not.toHaveBeenCalled()
    } finally { vi.mocked(WebSocket).mockImplementation(constructor) }
  })
})
