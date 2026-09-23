import { once } from "node:events"

import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

// A pairing code shown on a screen is a credential in the room until it is
// spent. These tests are the two claims the machine prints beside it: that it
// works once, and that it only mints the kind it was shown for. Every refusal
// reads the same, so spending codes teaches nothing about which ones exist.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const rpcDeadlineMs = 3_000

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

async function connect(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(rpcDeadlineMs) })
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
      finish()
    }
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.id === id) settle(() => resolve(message))
    }
    const closed = () => settle(() => reject(new Error(`${method} connection closed`)))
    socket.on("message", receive)
    socket.once("close", closed)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

function errorMessage(reply: Record<string, unknown>): string {
  return (reply.error as { message?: string } | undefined)?.message ?? ""
}

async function ownerOf(daemon: DomovoiDaemon) {
  const owner = await connect(daemon)
  expect(await call(owner, "system.hello", {
    client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).not.toHaveProperty("error")
  return owner
}

describe("a pairing code shown for a phone", () => {
  it("mints a phone credential once, and is dead the second time", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await ownerOf(daemon)

    const issued = await call(owner, "device.issueCode", { targetClient: "phone" })
    const { code } = issued.result as { code: string }

    const phone = await connect(daemon)
    const redeemed = await call(phone, "device.redeemCode", { code, label: "iPhone", protocolVersion })
    expect(redeemed).not.toHaveProperty("error")
    const { token, device } = redeemed.result as { token: string, device: { binding: { kind: string, client?: string } } }
    expect(device.binding).toEqual({ kind: "client", client: "phone", clientAccess: "full" })

    // The credential works, so the code really did pair this device.
    const paired = await connect(daemon)
    expect(await call(paired, "system.hello", {
      client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: token,
    })).not.toHaveProperty("error")
    expect(await call(paired, "workspace.get", {})).not.toHaveProperty("error")

    // A photograph of the same symbol now opens nothing.
    const second = await connect(daemon)
    const again = await call(second, "device.redeemCode", { code, label: "another phone", protocolVersion })
    expect(again).toHaveProperty("error")
    expect(errorMessage(again)).toBe("Pairing was refused")
  })

  it("cannot be spent as a machine pairing", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await ownerOf(daemon)
    const issued = await call(owner, "device.issueCode", { targetClient: "phone" })
    const { code } = issued.result as { code: string }

    const impostor = await connect(daemon)
    const claimed = await call(impostor, "device.claim", {
      code, label: "a machine", machineId: `machine-${"a".repeat(32)}`, protocolVersion,
    })
    expect(claimed).toHaveProperty("error")
    expect(errorMessage(claimed)).toBe("Pairing was refused")
  })
})

describe("a pairing code shown for a machine", () => {
  it("cannot be redeemed as a client credential", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await ownerOf(daemon)
    const issued = await call(owner, "device.issueCode", {})
    const { code } = issued.result as { code: string }

    const phone = await connect(daemon)
    const redeemed = await call(phone, "device.redeemCode", { code, label: "iPhone", protocolVersion })
    expect(redeemed).toHaveProperty("error")
    expect(errorMessage(redeemed)).toBe("Pairing was refused")
  })
})

describe("showing a second code", () => {
  it("replaces the first without restarting the daemon, and the first stops working", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await ownerOf(daemon)

    const first = ((await call(owner, "device.issueCode", { targetClient: "phone" })).result as { code: string }).code
    const second = ((await call(owner, "device.issueCode", { targetClient: "phone" })).result as { code: string }).code
    expect(second).not.toBe(first)

    // A scan that never reached the daemon costs nothing, but a code the
    // operator replaced is gone: only the one on screen pairs.
    const stale = await connect(daemon)
    const refused = await call(stale, "device.redeemCode", { code: first, label: "iPhone", protocolVersion })
    expect(refused).toHaveProperty("error")
    expect(errorMessage(refused)).toBe("Pairing was refused")

    const phone = await connect(daemon)
    const redeemed = await call(phone, "device.redeemCode", { code: second, label: "iPhone", protocolVersion })
    expect(redeemed).not.toHaveProperty("error")
    expect((redeemed.result as { device: { binding: unknown } }).device.binding).toEqual({ kind: "client", client: "phone", clientAccess: "full" })
  })
})
