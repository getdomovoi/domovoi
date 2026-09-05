import { once } from "node:events"
import { createServer, type Server, type Socket } from "node:net"

import { WebSocketServer } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { createEmptyWorkspace, demoWorkspace, protocolVersion, type FleetMachineFacts } from "@getdomovoi/protocol"

import { Deadline } from "../../../packages/ui/src/deadline.js"
import { connectMachineClient } from "../../../packages/ui/src/machine-client.js"
import { createMachineDialer } from "./machine-dial.js"
import { openMachineSocket } from "./machine-socket.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import { waitForDaemon } from "./test-wait-for.js"

const machineId = `machine-${"a".repeat(32)}`
const credential = "n".repeat(43)
const workspace = createEmptyWorkspace({ ...demoWorkspace.machine, id: machineId })
const dialMs = 4_000
const observationMs = 5_000
const servers: Array<Server | WebSocketServer> = []
const sockets: Socket[] = []
const releases: Array<() => void> = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) {
    if (server instanceof WebSocketServer) {
      for (const client of server.clients) client.terminate()
    }
    const closed = once(server, "close", { signal: AbortSignal.timeout(observationMs) })
    server.close()
    await closed
  }
})

async function listener(phase: "upgrade" | "hello" | "ready") {
  const hellos: unknown[] = []
  let connections = 0
  let closed = 0
  const server = phase === "upgrade"
    ? createServer((socket) => {
        sockets.push(socket)
        // Count the upgrade request, not an idle connection the native
        // WebSocket implementation may preconnect through its HTTP pool.
        socket.once("data", () => {
          connections += 1
          socket.on("close", () => { closed += 1 })
        })
        socket.resume()
      })
    : new WebSocketServer({ host: "127.0.0.1", port: 0 })
  servers.push(server)
  const listening = once(server, "listening", { signal: AbortSignal.timeout(observationMs) })
  if (server instanceof WebSocketServer) {
    server.on("connection", (socket) => {
      connections += 1
      socket.on("close", () => { closed += 1 })
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id: number; method: string; params: unknown }
        hellos.push(request)
        if (phase === "ready") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: workspace }))
        }
      })
    })
  } else {
    server.listen(0, "127.0.0.1")
  }
  await listening
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("Listener has no bound port")
  return {
    endpoint: `ws://127.0.0.1:${address.port}/rpc`, hellos,
    connections: () => connections,
    closed: () => closed,
  }
}

describe("fleet fallback over real sockets", () => {
  it.each([
    ["client", "upgrade"], ["client", "hello"],
    ["daemon", "upgrade"], ["daemon", "hello"],
  ] as const)("%s reaches fallback after a silent %s", async (side, phase) => {
      const silent = await listener(phase)
      const ready = await listener("ready")
      let endpoint: string
      if (side === "client") {
        const deadline = Deadline.start(dialMs)
        releases.push(() => deadline.clear())
        const connected = await connectMachineClient({
          candidates: [
            { kind: "local", endpoint: silent.endpoint, authenticated: true },
            { kind: "ssh", endpoint: ready.endpoint, authenticated: true, configured: true },
          ],
          credential, kind: "desktop", budgets: { connectMs: dialMs, requestMs: dialMs }, deadline,
        })
        releases.push(() => connected.client.disconnect())
        endpoint = connected.transport.endpoint
        expect(deadline.remainingMs()).toBeGreaterThan(0)
      } else {
        const facts: FleetMachineFacts = {
          ...workspace.machine, label: "studio", connection: "direct", protocolVersion,
          capabilities: ["sessions"], transports: [],
          verifiedRoute: { endpoint: silent.endpoint, lastAuthenticatedAt: new Date(0).toISOString() },
        }
        const dial = createMachineDialer({
          machine: () => facts,
          credentials: asyncTestCredentials({
            save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential,
          }),
          sshTunnels: [{ machineId, endpoint: ready.endpoint }], dialTimeoutMs: dialMs,
          open: (input) => openMachineSocket({ ...input, callTimeoutMs: dialMs }),
        })
        const connected = await dial(machineId)
        releases.push(() => connected.close())
        endpoint = connected.endpoint
      }
      expect(endpoint).toBe(ready.endpoint)
      expect(silent.connections()).toBe(1)
      expect(silent.hellos).toHaveLength(phase === "hello" ? 1 : 0)
      expect(ready.hellos).toEqual([expect.objectContaining({
        method: "system.hello", params: expect.objectContaining({
          authToken: credential, protocolVersion, client: side === "client" ? "desktop" : "machine",
        }),
      })])
      await waitForDaemon(() => expect(silent.closed()).toBe(1))
  }, 20_000)
})
