import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { daemonAuthenticationErrorCode, protocolVersion } from "@getdomovoi/protocol"

import { CodeRedemptionClient, createBrowserPairingClient } from "./browser-pairing-client"
import { DaemonRpcError, DomovoiClient } from "./client"
import { installFakeWebSocket, type FakeWebSocketHarness } from "./test-support/fake-websocket"

const url = "ws://127.0.0.1:47831/rpc"
const params = { code: "hearth-quiet-ember-42", label: "Web browser 4f2a1c9d", protocolVersion }
const result = { token: "d".repeat(43) }

let harness: FakeWebSocketHarness

beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => {
  vi.useRealTimers()
  harness.uninstall()
})

async function opened(client = new CodeRedemptionClient(url, 1_000)) {
  const connecting = client.connect()
  harness.socket(harness.sockets.length - 1).open()
  await connecting
  return { client, socket: harness.socket(harness.sockets.length - 1) }
}

describe("browser pairing client", () => {
  it("pairs a bearer through the greeting client and a code through the one-call client", () => {
    expect(createBrowserPairingClient({ url, client: "web", bearer: "r".repeat(43) })).toBeInstanceOf(DomovoiClient)
    expect(createBrowserPairingClient({ url, client: "web" })).toBeInstanceOf(CodeRedemptionClient)
    expect(harness.sockets).toHaveLength(0)
  })
})

describe("code redemption client", () => {
  it("opens the socket without sending anything, then sends the code alone and closes", async () => {
    const { client, socket } = await opened()
    expect(socket.sent).toEqual([])

    const reply = client.request("device.redeemCode", params)
    expect(socket.sent).toEqual([{ jsonrpc: "2.0", id: 1, method: "device.redeemCode", params }])
    socket.receive({ jsonrpc: "2.0", id: 1, result })
    await expect(reply).resolves.toEqual(result)

    client.disconnect()
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "client closed" }])
  })

  it("rejects with the daemon's own error when it refuses the code", async () => {
    const { client, socket } = await opened()
    const reply = client.request("device.redeemCode", params)
    socket.receive({ jsonrpc: "2.0", id: 1, error: { code: daemonAuthenticationErrorCode, message: "Pairing was refused" } })
    const refusal = await reply.catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(DaemonRpcError)
    expect(refusal).toMatchObject({ code: daemonAuthenticationErrorCode, message: "Pairing was refused" })
  })

  it("reads only the reply to its request", async () => {
    vi.useFakeTimers()
    const { client, socket } = await opened()
    socket.receive({ jsonrpc: "2.0", id: 1, result: "before the request" })
    const reply = client.request("device.redeemCode", params)
    socket.dispatchEvent(new MessageEvent("message", { data: "not json" }))
    socket.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(1) }))
    socket.receive({ jsonrpc: "2.0", id: 2, result: "another request" })
    socket.receive({ jsonrpc: "2.0", method: "system.notice" })
    socket.receive({ jsonrpc: "2.0", id: 1, result })
    await expect(reply).resolves.toEqual(result)
  })

  it("says the daemon did not answer when the reply never comes", async () => {
    vi.useFakeTimers()
    const { client } = await opened()
    const reply = client.request("device.redeemCode", params)
    vi.advanceTimersByTime(1_000)
    await expect(reply).rejects.toThrow("Daemon did not answer device.redeemCode within 1000 ms")
  })

  it("says the connection never opened when the socket stays closed", async () => {
    vi.useFakeTimers()
    const connecting = new CodeRedemptionClient(url, 1_000).connect()
    vi.advanceTimersByTime(1_000)
    await expect(connecting).rejects.toThrow("Daemon did not open a connection within 1000 ms")
  })

  it("rejects when the socket fails or closes before the reply", async () => {
    const failing = new CodeRedemptionClient(url, 1_000).connect()
    harness.socket(0).dispatchEvent(new Event("error"))
    await expect(failing).rejects.toThrow("Daemon connection failed")

    const { client, socket } = await opened()
    const reply = client.request("device.redeemCode", params)
    socket.drop()
    await expect(reply).rejects.toThrow("Daemon connection closed")
  })

  it("rejects a pending call when the page disconnects", async () => {
    const { client } = await opened()
    const reply = client.request("device.redeemCode", params)
    client.disconnect()
    await expect(reply).rejects.toThrow("Daemon connection closed")
  })

  it("sends the code once, on one open socket, and never before it opened", async () => {
    const unopened = new CodeRedemptionClient(url, 1_000)
    await expect(unopened.request("device.redeemCode", params)).rejects.toThrow("Daemon connection closed")
    unopened.disconnect()

    const { client, socket } = await opened()
    await expect(client.connect()).rejects.toThrow("A code redemption client opens one connection")
    void client.request("device.redeemCode", params).catch(() => undefined)
    await expect(client.request("device.redeemCode", params)).rejects.toThrow("Daemon connection closed")
    expect(socket.sent).toHaveLength(1)

    const { client: dropped, socket: droppedSocket } = await opened()
    droppedSocket.drop()
    await expect(dropped.request("device.redeemCode", params)).rejects.toThrow("Daemon connection closed")
  })

  it("rejects when the socket cannot be created or cannot send", async () => {
    harness.uninstall()
    const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
    try {
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class { constructor() { throw new SyntaxError("Invalid URL") } } })
      await expect(new CodeRedemptionClient("not a url", 1_000).connect()).rejects.toThrow("Invalid URL")
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class { constructor() { throw "no reason" } } })
      await expect(new CodeRedemptionClient(url, 1_000).connect()).rejects.toThrow("Daemon socket could not be created")
    } finally {
      if (original) Object.defineProperty(globalThis, "WebSocket", original)
      else delete (globalThis as { WebSocket?: unknown }).WebSocket
    }
    harness = installFakeWebSocket()

    const { client, socket } = await opened()
    socket.send = () => { throw new Error("socket is closing") }
    await expect(client.request("device.redeemCode", params)).rejects.toThrow("socket is closing")
  })
})
