import { once } from "node:events"

import { protocolVersion, rpcMethodAuthorizations, rpcMethods, type RpcMethod } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const rpcDeadlineMs = 3_000

async function connect(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(rpcDeadlineMs) })
  let id = 0
  return async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new Error(`${method} deadline expired`))), rpcDeadlineMs)
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        socket.off("message", receive)
        finish()
      }
      const receive = (data: WebSocket.RawData) => {
        const reply = JSON.parse(data.toString()) as Record<string, unknown>
        if (reply.id === requestId) settle(() => resolve(reply))
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
}

function errorMessage(reply: Record<string, unknown>) {
  return (reply.error as { message?: string } | undefined)?.message ?? ""
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

describe("watching client access", () => {
  it("refuses every control method before parsing parameters and permits every observe method", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()

    const owner = await connect(daemon)
    expect(await owner("system.hello", {
      client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })).not.toHaveProperty("error")
    const minted = await owner("device.pair", {
      label: "Watching browser", client: "cli", targetClient: "web", clientAccess: "watching",
    })
    expect(minted).not.toHaveProperty("error")
    const { token, device } = minted.result as {
      token: string
      device: { id: string; binding: unknown }
    }
    expect(device.binding).toEqual({ kind: "client", client: "web", clientAccess: "watching" })

    const watching = await connect(daemon)
    const hello = await watching("system.hello", {
      client: "web", clientVersion: "0.0.1", protocolVersion, authToken: token,
    })
    expect(hello).toMatchObject({ result: { clientAccess: "watching" } })
    expect(await watching("device.current", {})).toMatchObject({
      result: { kind: "client", deviceId: device.id, client: "web", clientAccess: "watching" },
    })

    const refusal = /Watching-only credentials may only observe/
    const methods = Object.keys(rpcMethods) as RpcMethod[]
    for (const method of methods.filter((candidate) => rpcMethodAuthorizations[candidate] === "control")) {
      const reply = await watching(method, {})
      expect(errorMessage(reply), method).toMatch(refusal)
    }
    for (const method of methods.filter((candidate) => rpcMethodAuthorizations[candidate] === "observe")) {
      if (method === "system.hello" || method === "device.current") continue
      const reply = await watching(method, {})
      expect(errorMessage(reply), method).not.toMatch(refusal)
    }
  })

  it.each(["terminal.create", "terminal.claim", "terminal.input", "terminal.resize", "terminal.close"] as const)(
    "refuses %s despite its persistence-read-only classification",
    async (method) => {
      const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
      daemons.push(daemon)
      await daemon.start()
      const owner = await connect(daemon)
      await owner("system.hello", {
        client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
      })
      const minted = await owner("device.pair", {
        label: "Watcher", client: "cli", targetClient: "desktop", clientAccess: "watching",
      })
      const token = (minted.result as { token: string }).token
      const watching = await connect(daemon)
      await watching("system.hello", {
        client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: token,
      })
      expect(errorMessage(await watching(method, {}))).toMatch(/Watching-only credentials may only observe/)
    },
  )

  it("keeps omitted access and local-owner credentials fully authorized", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await connect(daemon)
    expect(await owner("system.hello", {
      client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })).toMatchObject({ result: { clientAccess: "full" } })
    const minted = await owner("device.pair", { label: "Desktop", client: "cli", targetClient: "desktop" })
    expect(minted).toMatchObject({
      result: { device: { binding: { kind: "client", client: "desktop", clientAccess: "full" } } },
    })
    const token = (minted.result as { token: string }).token
    const full = await connect(daemon)
    expect(await full("system.hello", {
      client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: token,
    })).toMatchObject({ result: { clientAccess: "full" } })
    expect(errorMessage(await full("terminal.input", {}))).not.toMatch(/Watching-only credentials may only observe/)
  })
})
