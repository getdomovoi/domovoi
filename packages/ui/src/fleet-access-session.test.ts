import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { FleetAccessSession } from "./fleet-access-session.js"
import { installFakeWebSocket, completeHandshake, respond, sentRequests } from "./test-support/fake-websocket"

const machineId = demoWorkspace.machine.id
const deviceId = `device-${"a".repeat(32)}`
let sockets: ReturnType<typeof installFakeWebSocket>
let access: FleetAccessSession
beforeEach(() => {
  vi.useFakeTimers()
  sockets = installFakeWebSocket()
  access = new FleetAccessSession(() => ({ homeUrl: "ws://localhost/rpc", kind: "web", route: async () => ({
    outcome: "ready", machineId, transport: { kind: "local", endpoint: "ws://localhost/rpc", authenticated: true },
  }) }))
})
afterEach(() => { access.clear(); sockets.uninstall(); vi.useRealTimers() })

it("keeps controls unadmitted until identity and a client receipt both succeed", async () => {
  const pending = access.authorize(machineId, "a".repeat(43), new AbortController().signal)
  expect(access.snapshot()[machineId]).toEqual({ state: "checking" })
  await vi.advanceTimersByTimeAsync(0)
  completeHandshake(sockets.socket(0))
  await vi.advanceTimersByTimeAsync(0)
  expect(access.access(machineId)).toBeUndefined()
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web" })
  await pending
  expect(access.snapshot()[machineId]).toEqual({ state: "admitted", deviceId })
  expect(access.access(machineId)?.credential).toBe("a".repeat(43))
  expect(JSON.stringify(access.snapshot())).not.toContain("a".repeat(43))
  access.remove(machineId)
  expect(access.access(machineId)).toBeUndefined()
  expect(access.snapshot()[machineId]).toBeUndefined()
})

it("does not resurrect an access check cancelled after hello", async () => {
  const cancel = new AbortController()
  const pending = access.authorize(machineId, "a".repeat(43), cancel.signal)
  await vi.advanceTimersByTimeAsync(0)
  completeHandshake(sockets.socket(0))
  await vi.advanceTimersByTimeAsync(0)
  cancel.abort()
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web" })
  await pending
  expect(access.access(machineId)).toBeUndefined()
  expect(access.snapshot()[machineId]).toBeUndefined()
})

it("never opens an inventory connection without client authority", async () => {
  await expect(access.inventory(machineId, new AbortController().signal)).rejects.toMatchObject({ reason: "client-credential-required" })
  expect(sockets.sockets).toHaveLength(0)
})

it("uses the admitted client for inventory and withdraws access on revocation during its read", async () => {
  const pending = access.authorize(machineId, "a".repeat(43), new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  completeHandshake(sockets.socket(0))
  await vi.advanceTimersByTimeAsync(0)
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web" })
  await pending
  const opening = access.inventory(machineId, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  const readerSocket = sockets.socket(1)
  completeHandshake(readerSocket)
  await vi.advanceTimersByTimeAsync(0)
  expect(sentRequests(readerSocket, "skill.inventory")).toHaveLength(0)
  expect(sentRequests(readerSocket, "system.hello")[0]?.params).toMatchObject({ client: "web", authToken: "a".repeat(43) })
  respond(readerSocket, "device.current", { kind: "client", machineId, deviceId, client: "web" })
  const reader = await opening
  const inventory = reader.inventory().catch((error: unknown) => error)
  expect(sentRequests(readerSocket, "skill.inventory")).toHaveLength(1)
  readerSocket.drop(1008, "secret from remote")
  expect(await inventory).toMatchObject({ reason: "client-credential-required" })
  expect(access.access(machineId)).toBeUndefined()
  expect(access.snapshot()[machineId]).toMatchObject({ state: "refused" })
  expect(JSON.stringify(access.snapshot())).not.toContain("secret from remote")
  reader.close()
})
