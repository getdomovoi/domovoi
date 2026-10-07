import { demoWorkspace, type FleetEntry, type FleetMachine } from "@getdomovoi/protocol"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { asOf, FleetAccessSession, fleetAgents } from "./fleet-access-session.js"
import { installFakeWebSocket, completeHandshake, respond, sentRequests, workspaceSnapshot } from "./test-support/fake-websocket"

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
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await pending
  expect(access.snapshot()[machineId]).toMatchObject({ state: "admitted", deviceId })
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
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
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
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await pending
  const opening = access.inventory(machineId, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  const readerSocket = sockets.socket(1)
  completeHandshake(readerSocket)
  await vi.advanceTimersByTimeAsync(0)
  expect(sentRequests(readerSocket, "skill.inventory")).toHaveLength(0)
  expect(sentRequests(readerSocket, "system.hello")[0]?.params).toMatchObject({ client: "web", authToken: "a".repeat(43) })
  respond(readerSocket, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
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

it("asks an admitted machine directly for a session search and shows nothing without authority", async () => {
  await expect(access.search(machineId, "billing", new AbortController().signal)).rejects.toMatchObject({ reason: "client-credential-required" })
  const pending = access.authorize(machineId, "a".repeat(43), new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  completeHandshake(sockets.socket(0))
  await vi.advanceTimersByTimeAsync(0)
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await pending
  const searching = access.search(machineId, "billing", new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  const socket = sockets.socket(1)
  completeHandshake(socket)
  await vi.advanceTimersByTimeAsync(0)
  respond(socket, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await vi.advanceTimersByTimeAsync(0)
  expect(sentRequests(socket, "session.search")[0]?.params).toMatchObject({ query: "billing", limit: 20 })
  respond(socket, "session.search", { query: "billing", truncated: false, matches: [{ session: demoWorkspace.sessions[0]!, matchedIn: "title" }] })
  const result = await searching
  expect(result.matches).toHaveLength(1)
  expect(socket.readyState).not.toBe(1)
})

it("gives Settings each machine's agents from its own reading and says which are unknown", () => {
  const machine = (id: string, label: string, self: boolean, health: FleetMachine["health"] = "healthy"): FleetEntry => ({ kind: "machine", machine: {
    id, label, self, health, platform: "linux", arch: "x64", version: "0.1.0", protocolVersion: "0.1.0", connection: self ? "local" : "tailnet",
    capabilities: ["sessions"], transports: [], heartbeat: { state: "online", lastSeenAt: "2026-10-06T14:00:00.000Z" },
  } })
  const codex = { id: "codex", command: "codex", status: "ready" as const, sessionCapable: true }
  const readAt = "2026-10-06T14:03:00.000Z"
  const ids = { home: `machine-${"a".repeat(32)}`, studio: `machine-${"b".repeat(32)}`, lab: `machine-${"c".repeat(32)}`, lost: `machine-${"d".repeat(32)}` }
  const rows = fleetAgents([
    machine(ids.home, "workshop", true),
    machine(ids.studio, "studio", false),
    machine(ids.lab, "lab", false),
    machine(ids.lost, "lost", false, "unreachable"),
    { kind: "unenrolled", machineId: `machine-${"e".repeat(32)}` },
  ], {
    readings: { [ids.home]: { providers: [codex], sessions: [], readAt } },
    clientAccess: {
      [ids.studio]: { state: "admitted", deviceId, reading: { providers: [], sessions: [], readAt } },
      [ids.lost]: { state: "admitted", deviceId, reading: { providers: [codex], sessions: [], readAt } },
    },
    currentMachineId: ids.home,
  })

  expect(rows).toEqual([
    { machineId: ids.home, label: "workshop", providers: [codex], stale: undefined },
    { machineId: ids.studio, label: "studio", providers: [], stale: undefined },
    { machineId: ids.lab, label: "lab", unknown: "this app holds no client credential for it" },
    { machineId: ids.lost, label: "lost", providers: [codex], stale: asOf(readAt) },
  ])
})

async function admit(snapshot = workspaceSnapshot()): Promise<void> {
  const pending = access.authorize(machineId, "a".repeat(43), new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  completeHandshake(sockets.socket(0), snapshot)
  await vi.advanceTimersByTimeAsync(0)
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await pending
}

it("keeps what the admitted machine reported about its agents and sessions, and nothing else", async () => {
  vi.setSystemTime(new Date("2026-10-06T14:03:00.000Z"))
  await admit(workspaceSnapshot({
    machine: { ...demoWorkspace.machine, providers: [{ id: "codex", command: "codex", status: "ready", sessionCapable: true }] },
  }))
  const state = access.snapshot()[machineId]
  expect(state).toMatchObject({ state: "admitted", deviceId, reading: { readAt: "2026-10-06T14:03:00.000Z" } })
  const reading = state?.state === "admitted" ? state.reading : undefined
  expect(reading?.providers.map((provider) => provider.id)).toEqual(["codex"])
  expect(reading?.sessions.map((session) => [session.title, session.state])).toEqual(
    demoWorkspace.sessions.map((session) => [session.title, session.state]))
  expect(JSON.stringify(reading)).not.toContain("a".repeat(43))
})

it("reads an admitted machine again and keeps the last reading when it does not answer", async () => {
  await expect(access.read(machineId, new AbortController().signal)).rejects.toMatchObject({ reason: "client-credential-required" })
  expect(sockets.sockets).toHaveLength(0)
  vi.setSystemTime(new Date("2026-10-06T14:03:00.000Z"))
  await admit()
  vi.setSystemTime(new Date("2026-10-06T14:05:00.000Z"))
  const reading = access.read(machineId, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  const socket = sockets.socket(1)
  const [billing] = demoWorkspace.sessions
  completeHandshake(socket, workspaceSnapshot({ sessions: [{ ...billing!, state: "failed" }] }))
  await vi.advanceTimersByTimeAsync(0)
  respond(socket, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await reading
  expect(access.snapshot()[machineId]).toMatchObject({ state: "admitted", reading: {
    readAt: "2026-10-06T14:05:00.000Z", sessions: [{ id: billing!.id, title: billing!.title, state: "failed" }],
  } })
  expect(socket.readyState).not.toBe(1)

  const silent = access.read(machineId, new AbortController().signal).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(11_000)
  expect(await silent).toBeInstanceOf(Error)
  expect(access.access(machineId)).toBeDefined()
  expect(access.snapshot()[machineId]).toMatchObject({ state: "admitted", reading: { readAt: "2026-10-06T14:05:00.000Z" } })
})
