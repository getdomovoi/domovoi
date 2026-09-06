import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { DomovoiClient } from "./client"
import { installFakeWebSocket, completeHandshake, fail, notify, respond } from "./test-support/fake-websocket"

const machineId = demoWorkspace.machine.id
const deviceId = `device-${"a".repeat(32)}`
const budgets = { connectMs: 1_000, requestMs: 10_000 }
let sockets: ReturnType<typeof installFakeWebSocket>
let client: DomovoiClient
beforeEach(() => { vi.useFakeTimers(); sockets = installFakeWebSocket() })
afterEach(() => { client?.disconnect(); sockets.uninstall(); vi.useRealTimers() })

describe("client credential admission", () => {
  function connect(expectedMachine = machineId) {
    client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      budgets, authToken: "a".repeat(43), admission: { machineId: expectedMachine, deviceId },
    })
    const snapshots = vi.fn()
    client.addEventListener("snapshot", snapshots)
    const outcome = client.connect().catch((error: unknown) => error)
    return { outcome, snapshots }
  }

  it("refuses the wrong machine before exposing its snapshot", async () => {
    const { outcome, snapshots } = connect(`machine-${"b".repeat(32)}`)
    completeHandshake(sockets.socket(0))
    expect(await outcome).toMatchObject({ name: "ClientAdmissionError", reason: "identity-mismatch" })
    expect(snapshots).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sockets.sockets).toHaveLength(1)
  })

  it("holds notifications until the kind-bound credential receipt is verified", async () => {
    const { outcome, snapshots } = connect()
    completeHandshake(sockets.socket(0))
    notify(sockets.socket(0), "workspace.changed", demoWorkspace)
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots).not.toHaveBeenCalled()
    respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "desktop" })
    expect(await outcome).toEqual(demoWorkspace)
    expect(snapshots).toHaveBeenCalledTimes(2)
    expect(client.admittedDeviceId).toBe(deviceId)
  })

  it.each([
    { kind: "daemon" as const, machineId },
    { kind: "client" as const, machineId, deviceId, client: "web" as const },
    { kind: "client" as const, machineId, deviceId: `device-${"b".repeat(32)}`, client: "desktop" as const },
  ])("refuses authority that differs from the admitted client: %j", async (receipt) => {
    const { outcome, snapshots } = connect()
    completeHandshake(sockets.socket(0))
    await vi.advanceTimersByTimeAsync(0)
    respond(sockets.socket(0), "device.current", receipt)
    expect(await outcome).toMatchObject({ name: "ClientAdmissionError", reason: "client-credential-required" })
    expect(snapshots).not.toHaveBeenCalled()
  })

  it("includes receipt verification in the connect budget", async () => {
    const { outcome, snapshots } = connect()
    await vi.advanceTimersByTimeAsync(800)
    completeHandshake(sockets.socket(0))
    await vi.advanceTimersByTimeAsync(200)
    expect(await outcome).toMatchObject({ name: "DomovoiConnectTimeoutError" })
    expect(snapshots).not.toHaveBeenCalled()
    expect(sockets.socket(0).readyState).toBe(sockets.socket(0).CLOSED)
  })

  it("checks the receipt again after reconnect", async () => {
    const { outcome, snapshots } = connect()
    completeHandshake(sockets.socket(0))
    await vi.advanceTimersByTimeAsync(0)
    respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "desktop" })
    await outcome
    sockets.socket(0).drop()
    await vi.advanceTimersByTimeAsync(1_500)
    completeHandshake(sockets.socket(1))
    await vi.advanceTimersByTimeAsync(0)
    respond(sockets.socket(1), "device.current", { kind: "daemon", machineId })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snapshots).toHaveBeenCalledTimes(1)
    expect(sockets.sockets).toHaveLength(2)
  })

  it("keeps credential rejection typed and does not render remote error text", async () => {
    const { outcome, snapshots } = connect()
    sockets.socket(0).open()
    fail(sockets.socket(0), "system.hello", { code: -32001, message: "secret-from-remote" })
    expect(await outcome).toMatchObject({ name: "ClientAdmissionError", reason: "client-credential-required" })
    expect(String(await outcome)).not.toContain("secret-from-remote")
    expect(snapshots).not.toHaveBeenCalled()
  })

  it("bounds notifications while a receipt is outstanding", async () => {
    const { outcome, snapshots } = connect()
    completeHandshake(sockets.socket(0))
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 129; index += 1) notify(sockets.socket(0), "fleet.changed", { entries: [] })
    expect(await outcome).toMatchObject({ name: "ClientAdmissionError", reason: "verification-unavailable" })
    expect(snapshots).not.toHaveBeenCalled()
    expect(sockets.socket(0).readyState).toBe(sockets.socket(0).CLOSED)
  })
})
