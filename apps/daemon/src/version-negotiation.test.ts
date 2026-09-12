import { once, on } from "node:events"

import { afterEach, expect, it } from "vitest"
import { WebSocket } from "ws"

import {
  daemonAuthenticationErrorCode, demoWorkspace, protocolMismatchSchema,
  protocolVersion, protocolVersionMismatchErrorCode, systemHelloResultSchema,
} from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { productionRpcTimeoutMs } from "./test-wait-for.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const daemon of daemons.splice(0)) await daemon.stop()
})

async function fixture() {
  const store = new SqliteWorkspaceStore(":memory:", structuredClone(demoWorkspace))
  const daemon = new DomovoiDaemon({ port: 0, store })
  daemons.push(daemon)
  const address = await daemon.start()
  const paired = store.devices.pair({ label: "version-test", binding: { kind: "client", client: "cli" } })
  const connect = async () => {
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    sockets.push(socket)
    await once(socket, "open")
    let id = 0
    const call = async (method: string, params: object) => {
      const requestId = ++id
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), productionRpcTimeoutMs(process.platform))
      const messages = on(socket, "message", { signal: controller.signal })
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
        for await (const [data] of messages) {
          const response = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: unknown }
          if (response.id === requestId) return response
        }
        throw new Error("Socket ended before its response")
      } finally {
        clearTimeout(timeout)
        await messages.return?.()
      }
    }
    const hello = (version: string | undefined) => call("system.hello", {
      client: "cli", clientVersion: "1.2.3", authToken: paired.token,
      ...(version === undefined ? {} : { protocolVersion: version }),
    })
    return { call, hello }
  }
  return { connect, store, paired }
}

it("negotiates a compatible patch independently of product version and permits workspace access", async () => {
  const { connect } = await fixture()
  const client = await connect()
  const response = await client.hello(protocolVersion.replace(/\d+$/, "1"))
  expect(response.error).toBeUndefined()
  expect(systemHelloResultSchema.parse(response.result).protocolVersion).toBe(protocolVersion)
  expect(await client.call("workspace.get", {})).toMatchObject({ result: { protocolVersion } })
})

it.each([
  ["0.5.0", "machine-ahead"], ["0.7.0", "machine-behind"], ["1.2.0", "machine-behind"],
  [undefined, "machine-ahead"],
] as const)("refuses %s with direction and keeps ordinary RPCs closed", async (version, compatibility) => {
  const { connect } = await fixture()
  const client = await connect()
  const response = await client.hello(version)
  expect(response).not.toHaveProperty("result")
  expect(response.error).toMatchObject({ code: protocolVersionMismatchErrorCode,
    message: `This daemon speaks protocol ${protocolVersion}; the client speaks ${version ?? "0.1.0"}` })
  const error = response.error as { data: unknown }
  expect(protocolMismatchSchema.parse(error.data)).toEqual({ kind: "protocol-mismatch",
    daemonProtocolVersion: protocolVersion, clientProtocolVersion: version ?? "0.1.0", compatibility })
  expect(await client.call("workspace.get", {})).toMatchObject({ error: { code: daemonAuthenticationErrorCode } })
})

it("keeps a paired credential usable after version refusal and reconnect", async () => {
  const { connect, store, paired } = await fixture()
  const client = await connect()
  expect((await client.hello("0.5.0")).error).toMatchObject({ code: protocolVersionMismatchErrorCode })
  expect((await client.hello(protocolVersion)).error).toBeUndefined()
  const reconnected = await connect()
  expect((await reconnected.hello(protocolVersion)).error).toBeUndefined()
  expect(store.devices.list().map((device) => device.id)).toEqual([paired.device.id])
})

it.each(["00.6.0", "0.6.0\n", "1".repeat(61) + ".0.0"])("refuses malformed hello %j before admitting the client", async (version) => {
  const { connect } = await fixture()
  const client = await connect()
  expect((await client.hello(version)).error).toMatchObject({ code: -32602 })
  expect((await client.call("workspace.get", {})).error).toMatchObject({ code: daemonAuthenticationErrorCode })
})

it.each(["00.6.0", "0.6.0\n", "1".repeat(61) + ".0.0"])("refuses malformed advertised protocol %j at construction", (advertisedProtocolVersion) => {
  const store = new SqliteWorkspaceStore(":memory:", structuredClone(demoWorkspace))
  try {
    expect(() => new DomovoiDaemon({ store, advertisedProtocolVersion })).toThrow("Advertised protocol version")
  } finally {
    store.close()
  }
})
