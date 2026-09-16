import { once } from "node:events"

import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

// `domovoid pair --client phone` prints "This phone credential grants session
// sends, approvals and terminals. It cannot change paired devices or enroll
// more machines." This test is that sentence checked against the daemon,
// so the scope a scanned pairing code claims is one the daemon enforces and
// not one the CLI copy asserts.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const rpcDeadlineMs = 3_000

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

async function connect(daemon: DomovoiDaemon) {
  const signal = AbortSignal.timeout(rpcDeadlineMs)
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  try {
    await once(socket, "open", { signal })
  } catch (error) {
    socket.terminate()
    throw error
  }
  return socket
}

let nextId = 1
function call(socket: WebSocket, method: string, params: Record<string, unknown>) {
  const id = nextId++
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => settle(() => reject(new Error(`${method} deadline expired`))), rpcDeadlineMs)
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      socket.off("message", receive)
      socket.off("close", closed)
      socket.off("error", failed)
      finish()
    }
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.id === id) settle(() => resolve(message))
    }
    const closed = () => settle(() => reject(new Error(`${method} connection closed`)))
    const failed = (error: Error) => settle(() => reject(error))
    socket.on("message", receive)
    socket.once("close", closed)
    socket.once("error", failed)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

function errorMessage(reply: Record<string, unknown>): string {
  const error = reply.error as { message?: string } | undefined
  return error?.message ?? ""
}

describe("a phone-scoped credential", () => {
  it("is refused for every device, fleet and code operation, and still reads and identifies itself", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()

    const owner = await connect(daemon)
    expect(await call(owner, "system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).not.toHaveProperty("error")
    const minted = await call(owner, "device.pair", { label: "iPhone", client: "cli", targetClient: "phone" })
    expect(minted).not.toHaveProperty("error")
    const { token, device } = minted.result as { token: string, device: { id: string, binding: { kind: string, client?: string } } }
    expect(device.binding).toEqual({ kind: "client", client: "phone" })

    const phone = await connect(daemon)
    expect(await call(phone, "system.hello", { client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: token })).not.toHaveProperty("error")

    // What the credential is for: reading the workspace and knowing itself.
    expect(await call(phone, "workspace.get", {})).not.toHaveProperty("error")
    const current = await call(phone, "device.current", {})
    expect(current.result).toMatchObject({ kind: "client", client: "phone", deviceId: device.id })
    expect(await call(phone, "device.list", {})).not.toHaveProperty("error")

    // What it must never do: mint, withdraw or rename devices, issue pairing
    // codes, or change the fleet. Each refusal names the daemon credential.
    const refused = [
      ["device.pair", { label: "another", client: "phone" }],
      ["device.pair", { label: "another", client: "phone", targetClient: "phone" }],
      ["device.revoke", { deviceId: device.id, client: "phone" }],
      ["device.rotate", { deviceId: device.id, client: "phone" }],
      ["device.rename", { deviceId: device.id, label: "renamed" }],
      ["device.issueCode", {}],
      ["fleet.forget", { machineId: `machine-${"a".repeat(32)}`, client: "phone" }],
    ] as const
    for (const [method, params] of refused) {
      const reply = await call(phone, method, params as Record<string, unknown>)
      expect(reply, method).toHaveProperty("error")
      expect(errorMessage(reply), method).toMatch(/requires the daemon credential/)
    }

    // The refusals changed nothing: the owner still sees one phone, active.
    const listed = await call(owner, "device.list", {})
    const devices = (listed.result as { devices: { id: string, revokedAt?: string }[] }).devices
    expect(devices.filter((entry) => entry.revokedAt === undefined).map((entry) => entry.id)).toEqual([device.id])
  })
})
