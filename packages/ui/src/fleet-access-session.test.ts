import { demoWorkspace, type FleetEntry, type FleetMachine } from "@getdomovoi/protocol"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { asOf, FleetAccessSession, fleetAgents, machineReading } from "./fleet-access-session.js"
import { installFakeWebSocket, completeHandshake, notify, respond, sentRequests, workspaceSnapshot } from "./test-support/fake-websocket"

const machineId = demoWorkspace.machine.id
const deviceId = `device-${"a".repeat(32)}`
let sockets: ReturnType<typeof installFakeWebSocket>
let access: FleetAccessSession
let routeDown = false
// Route requests asked of the home daemon, and an optional hold on their answers.
let routeCalls = 0
let routeHold: Promise<void> | undefined
beforeEach(() => {
  vi.useFakeTimers()
  sockets = installFakeWebSocket()
  routeDown = false
  routeCalls = 0
  routeHold = undefined
  access = new FleetAccessSession(() => ({ homeUrl: "ws://localhost/rpc", kind: "web", route: async () => {
    routeCalls += 1
    if (routeHold) await routeHold
    return routeDown
      ? { outcome: "refused", reason: "client-route-unavailable" }
      : { outcome: "ready", machineId, transport: { kind: "local", endpoint: "ws://localhost/rpc", authenticated: true } }
  } }))
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
    readings: { [ids.home]: { reading: { providers: [codex], sessions: [], readAt }, live: true } },
    clientAccess: {
      [ids.studio]: { state: "admitted", deviceId, reading: { providers: [], sessions: [], readAt } },
      [ids.lost]: { state: "admitted", deviceId, reading: { providers: [codex], sessions: [], readAt } },
    },
    currentMachineId: ids.home,
    connected: true,
  })

  expect(rows).toEqual([
    { machineId: ids.home, label: "workshop", providers: [codex], stale: undefined },
    { machineId: ids.studio, label: "studio", providers: [], stale: undefined },
    { machineId: ids.lab, label: "lab", unknown: "this app holds no client credential for it" },
    { machineId: ids.lost, label: "lost", providers: [codex], stale: asOf(readAt) },
  ])
})

it("dates every admitted reading while the home daemon is not connected", () => {
  const studio: FleetEntry = { kind: "machine", machine: {
    id: `machine-${"b".repeat(32)}`, label: "studio", self: false, health: "healthy", platform: "linux", arch: "x64", version: "0.1.0",
    protocolVersion: "0.1.0", connection: "tailnet", capabilities: ["sessions"], transports: [],
    heartbeat: { state: "online", lastSeenAt: "2026-10-06T14:00:00.000Z" },
  } }
  const readAt = "2026-10-06T14:03:00.000Z"
  const rows = fleetAgents([studio], {
    readings: {},
    clientAccess: { [`machine-${"b".repeat(32)}`]: { state: "admitted", deviceId, reading: { providers: [], sessions: [], readAt } } },
    currentMachineId: machineId,
    connected: false,
  })

  expect(rows).toEqual([{ machineId: `machine-${"b".repeat(32)}`, label: "studio", providers: [], stale: asOf(readAt) }])
})

it("reads a session with a pending approval as waiting, as the drawer does", () => {
  const billing = demoWorkspace.sessions.find((session) => session.id === "session-billing")!
  const snapshot = { ...demoWorkspace, sessions: [{ ...billing, state: "active" as const }] }
  expect(snapshot.approvals.map((approval) => approval.sessionId)).toEqual(["session-billing"])

  expect(machineReading(snapshot, new Date()).sessions).toEqual([{ id: "session-billing", title: billing.title, state: "waiting" }])
})

it("reads a session whose turn is still in flight as running, as the drawer does", () => {
  const onboarding = demoWorkspace.sessions.find((session) => session.id === "session-onboarding")!
  const snapshot = { ...demoWorkspace, approvals: [], sessions: [{ ...onboarding, state: "archiving" as const, activeTurnId: "turn-1" }] }

  expect(machineReading(snapshot, new Date()).sessions).toEqual([{ id: "session-onboarding", title: onboarding.title, state: "active" }])
})

it("dates an admitted reading for every health the home daemon will not route a read to", () => {
  const readAt = "2026-10-06T14:03:00.000Z"
  const healths = ["version-mismatch", "upgrade-required", "pairing-required", "credential-store-unavailable", "degraded"] as const
  const entries: FleetEntry[] = healths.map((health, index) => ({ kind: "machine", machine: {
    id: `machine-${String(index).repeat(32)}`, label: health, self: false, health, platform: "linux", arch: "x64", version: "0.1.0",
    protocolVersion: "0.1.0", connection: "tailnet", capabilities: ["sessions"], transports: [],
    heartbeat: { state: "online", lastSeenAt: "2026-10-06T14:00:00.000Z" },
  } }))
  const rows = fleetAgents(entries, {
    readings: {},
    clientAccess: Object.fromEntries(healths.map((_, index) =>
      [`machine-${String(index).repeat(32)}`, { state: "admitted" as const, deviceId, reading: { providers: [], sessions: [], readAt } }])),
    currentMachineId: machineId,
    connected: true,
  })

  expect(rows.map((row) => "stale" in row ? row.stale : undefined)).toEqual(healths.map(() => asOf(readAt)))
})

async function admit(snapshot = workspaceSnapshot()): Promise<void> {
  const pending = access.authorize(machineId, "a".repeat(43), new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  completeHandshake(sockets.socket(0), snapshot)
  await vi.advanceTimersByTimeAsync(0)
  respond(sockets.socket(0), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await pending
}

it("names the day of a reading that is not from today", () => {
  const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
  const day = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" })
  const today = new Date(2026, 9, 8, 15, 0)
  const earlier = new Date(2026, 9, 8, 9, 30)
  const yesterday = new Date(2026, 9, 7, 23, 50)
  vi.setSystemTime(today)

  expect(asOf(earlier.toISOString())).toBe(`as of ${clock.format(earlier)}`)
  expect(asOf(yesterday.toISOString())).toBe(`as of ${day.format(yesterday)} ${clock.format(yesterday)}`)
})

it("keeps a reconnecting machine's reading current when this client asked after the home daemon's latest heartbeat, whatever its own clock says", () => {
  // The home daemon's clock: its latest heartbeat from each machine.
  const heard = "2026-10-06T14:00:00.000Z"
  const machine = (id: string, label: string): FleetEntry => ({ kind: "machine", machine: {
    id, label, self: false, health: "reconnecting", platform: "linux", arch: "x64", version: "0.1.0", protocolVersion: "0.1.0",
    connection: "tailnet", capabilities: ["sessions"], transports: [], heartbeat: { state: "offline", lastSeenAt: heard },
  } })
  // This client's clock runs behind the home daemon's for the first and
  // ahead of it for the others, so readAt says nothing about the heartbeat.
  const answered = { id: `machine-${"b".repeat(32)}`, readAt: "2026-10-06T13:50:00.000Z", heardAt: heard }
  const before = { id: `machine-${"c".repeat(32)}`, readAt: "2026-10-06T14:05:00.000Z", heardAt: "2026-10-06T13:40:00.000Z" }
  const unseen = { id: `machine-${"d".repeat(32)}`, readAt: "2026-10-06T14:05:00.000Z" }
  const rows = fleetAgents([machine(answered.id, "answered"), machine(before.id, "before"), machine(unseen.id, "unseen")], {
    readings: {},
    clientAccess: Object.fromEntries([answered, before, unseen].map(({ id, ...reading }) =>
      [id, { state: "admitted" as const, deviceId, reading: { providers: [], sessions: [], ...reading } }])),
    currentMachineId: machineId,
    connected: true,
  })

  expect(rows.map((row) => "stale" in row ? row.stale : undefined)).toEqual([undefined, asOf(before.readAt), asOf(unseen.readAt)])
})

it("notes the home daemon's latest heartbeat it had seen when it asked the machine", async () => {
  const heartbeat = (lastSeenAt: string): FleetMachine => ({
    id: machineId, label: "studio", self: false, health: "healthy", platform: "linux", arch: "x64", version: "0.1.0",
    protocolVersion: "0.1.0", connection: "tailnet", capabilities: ["sessions"], transports: [],
    heartbeat: { state: "online", lastSeenAt },
  })
  access.retain([heartbeat("2026-10-06T14:00:00.000Z")])
  await admit()
  expect(access.snapshot()[machineId]).toMatchObject({ state: "admitted", reading: { heardAt: "2026-10-06T14:00:00.000Z" } })

  access.retain([heartbeat("2026-10-06T14:02:00.000Z")])
  const reading = access.read(machineId, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  const socket = sockets.socket(1)
  completeHandshake(socket)
  await vi.advanceTimersByTimeAsync(0)
  respond(socket, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await reading
  expect(access.snapshot()[machineId]).toMatchObject({ state: "admitted", reading: { heardAt: "2026-10-06T14:02:00.000Z" } })
})

it("reads the state after what the machine sent while it verified this client, not the hello alone", async () => {
  const billing = demoWorkspace.sessions.find((session) => session.id === "session-billing")!
  const quiet = workspaceSnapshot({ sessions: [{ ...billing, state: "active" }], approvals: [] })
  // An approval arrives between system.hello and device.current; the client
  // replays it before connect() resolves with the older hello snapshot.
  const gated = workspaceSnapshot({ sessions: [{ ...billing, state: "active" }] })
  expect(gated.approvals.map((approval) => approval.sessionId)).toEqual(["session-billing"])
  const elsewhere = `machine-${"e".repeat(32)}`
  const foreign = workspaceSnapshot({ ...quiet, machine: { ...quiet.machine, id: elsewhere },
    ...(quiet.project ? { project: { ...quiet.project, machineId: elsewhere } } : {}) })
  const answer = async (socket: number, ask: Promise<void>) => {
    await vi.advanceTimersByTimeAsync(0)
    completeHandshake(sockets.socket(socket), quiet)
    await vi.advanceTimersByTimeAsync(0)
    notify(sockets.socket(socket), "workspace.changed", gated)
    // A replayed snapshot naming another machine is not this machine's reading.
    notify(sockets.socket(socket), "workspace.changed", foreign)
    respond(sockets.socket(socket), "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
    await ask
  }
  const sessionState = () => {
    const state = access.snapshot()[machineId]
    return state?.state === "admitted" ? state.reading.sessions.map((session) => session.state) : undefined
  }

  await answer(0, access.authorize(machineId, "a".repeat(43), new AbortController().signal))
  expect(sessionState()).toEqual(["waiting"])

  await answer(1, access.read(machineId, new AbortController().signal))
  expect(sessionState()).toEqual(["waiting"])
})

it("dials at most four reads at once, across callers, and frees a slot only when a read ends", async () => {
  await admit()
  const before = routeCalls
  let answer!: () => void
  routeHold = new Promise<void>((resolve) => { answer = resolve })
  const reads = Array.from({ length: 6 }, () => new AbortController())
  const outcomes = reads.map((read) => access.read(machineId, read.signal).then(() => "read", (error: unknown) => error))
  await vi.advanceTimersByTimeAsync(0)
  expect(routeCalls - before).toBe(4)

  // A read cancelled while waiting leaves without dialing.
  reads[5]!.abort()
  expect(await outcomes[5]).toMatchObject({ name: "AbortError" })
  // A cancelled read still holds its route request, so it keeps its slot until it ends.
  reads[0]!.abort()
  await vi.advanceTimersByTimeAsync(0)
  expect(routeCalls - before).toBe(4)

  answer()
  await vi.advanceTimersByTimeAsync(0)
  expect(routeCalls - before).toBe(5)
  for (const read of reads) read.abort()
  await vi.advanceTimersByTimeAsync(11_000)
  await Promise.all(outcomes)
})

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
  // No approval pending, so the reading keeps the session's own state.
  completeHandshake(socket, workspaceSnapshot({ sessions: [{ ...billing!, state: "failed" }], approvals: [] }))
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
  expect(access.snapshot()[machineId]).toMatchObject({ state: "admitted", unanswered: true, reading: { readAt: "2026-10-06T14:05:00.000Z" } })

  // A machine that is down has no route from the home daemon. That is not a
  // refused credential, so a read nobody asked for keeps access and the reading.
  routeDown = true
  expect(await access.read(machineId, new AbortController().signal).catch((error: unknown) => error))
    .toMatchObject({ reason: "client-route-unavailable" })
  expect(access.access(machineId)).toBeDefined()
  expect(access.snapshot()[machineId]).toMatchObject({ state: "admitted", unanswered: true, reading: { readAt: "2026-10-06T14:05:00.000Z" } })

  // An answer clears it.
  routeDown = false
  const again = access.read(machineId, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(0)
  const answering = sockets.socket(sockets.sockets.length - 1)
  completeHandshake(answering)
  await vi.advanceTimersByTimeAsync(0)
  respond(answering, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" })
  await again
  expect(access.snapshot()[machineId]).not.toHaveProperty("unanswered")
})

it("withdraws access when a read finds the credential refused", async () => {
  await admit()
  const reading = access.read(machineId, new AbortController().signal).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  sockets.socket(1).open()
  sockets.socket(1).drop(1008, "revoked")
  expect(await reading).toMatchObject({ reason: "client-credential-required" })
  expect(access.access(machineId)).toBeUndefined()
  expect(access.snapshot()[machineId]).toMatchObject({ state: "refused" })
})
