import { once } from "node:events"

import { phoneAndTabletRpcMethods, protocolVersion, rpcMethods, type RpcMethod } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

// The pairing card promises what a phone may do: watch sessions, answer
// gates, start, stop and steer sessions, and never pull files down. This test
// is that promise checked against the daemon for every registered method, so
// the scope a scanned pairing code claims is one the daemon enforces and not
// one the card's copy asserts.

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
  it("is refused for every method outside the pairing card, and still reads and identifies itself", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()

    const owner = await connect(daemon)
    expect(await call(owner, "system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).not.toHaveProperty("error")
    const minted = await call(owner, "device.pair", { label: "iPhone", client: "cli", targetClient: "phone" })
    expect(minted).not.toHaveProperty("error")
    const { token, device } = minted.result as { token: string, device: { id: string, binding: { kind: string, client?: string } } }
    expect(device.binding).toEqual({ kind: "client", client: "phone", clientAccess: "full" })

    const phone = await connect(daemon)
    expect(await call(phone, "system.hello", { client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: token })).not.toHaveProperty("error")

    // What the credential is for: reading the workspace and knowing itself.
    expect(await call(phone, "workspace.get", {})).not.toHaveProperty("error")
    const current = await call(phone, "device.current", {})
    expect(current.result).toMatchObject({ kind: "client", client: "phone", deviceId: device.id })

    // Everything the card did not name is refused before its parameters are
    // read, so no request shape reaches those handlers.
    const refusal = /A phone or tablet credential may only watch sessions, answer gates, and start, stop or steer sessions/
    // relay.recovery is answered before authentication for every socket and
    // carries no session, file or device capability, so it is not a grant this
    // credential holds.
    const refused = (Object.keys(rpcMethods) as RpcMethod[])
      .filter((method) => !phoneAndTabletRpcMethods.has(method) && method !== "relay.recovery")
    expect(refused).toEqual(expect.arrayContaining([
      "terminal.create", "terminal.input", "terminal.claim", "session.revertFile", "checkpoint.restore",
      "skill.install", "audit.export", "device.pair", "device.revoke", "device.rotate",
      "device.rename", "device.issueCode", "device.list", "fleet.enroll", "fleet.forget", "session.transfer",
    ]))
    for (const method of refused) {
      const reply = await call(phone, method, {})
      expect(reply, method).toHaveProperty("error")
      expect(errorMessage(reply), method).toMatch(refusal)
    }
    // What the card names is never turned away for being a phone. A request
    // with empty parameters may still fail its own checks; that failure is
    // not the scope refusal.
    for (const method of phoneAndTabletRpcMethods) {
      if (method === "system.hello") continue
      const reply = await call(phone, method, {})
      expect(errorMessage(reply), method).not.toMatch(refusal)
    }

    // The refusals changed nothing: the owner still sees one phone, active.
    const listed = await call(owner, "device.list", {})
    const devices = (listed.result as { devices: { id: string, revokedAt?: string }[] }).devices
    expect(devices.filter((entry) => entry.revokedAt === undefined).map((entry) => entry.id)).toEqual([device.id])
  })
})
