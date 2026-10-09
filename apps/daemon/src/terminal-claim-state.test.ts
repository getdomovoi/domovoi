import { once } from "node:events"

import { demoWorkspace, maximumTerminalOutputChunkCharacters, maximumTerminalReplayCharacters, protocolVersion, terminalOutputBatchDelayMilliseconds, terminalWebSocketHighWaterBytes } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { DomovoiDaemon } from "./server.js"
import type { RpcOutboundSocket } from "./rpc-outbound.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { TerminalProcess } from "./terminal.js"
import { TerminalOutputBackpressure } from "./terminal-output.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const terminalId = "terminal-claim-state"
const firstTime = "2026-10-08T12:00:00.000Z"
const nextTime = "2026-10-08T12:01:00.000Z"
const graceMs = 60
type Reply = { result?: Record<string, unknown>, error?: { code: number, message: string } }
type Notice = { method: string, params: Record<string, unknown> }
type Connection = Awaited<ReturnType<Awaited<ReturnType<typeof start>>["connect"]>>

afterEach(async () => {
  vi.useRealTimers()
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  vi.restoreAllMocks()
})

async function start({ terminalReapGraceMs = graceMs }: { terminalReapGraceMs?: number } = {}) {
  // Keep network and reap timers real; only the claim clock is controlled.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(firstTime))
  let print = (_data: string) => {}
  let exit = (_event: { exitCode: number }) => {}
  const process = {
    process: "zsh", write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: vi.fn((listener: typeof print) => { print = listener; return { dispose: vi.fn() } }),
    onExit: vi.fn((listener: typeof exit) => { exit = listener; return { dispose: vi.fn() } }),
  } satisfies TerminalProcess
  const spawn = vi.fn(() => process)
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.workspacePath = "/worktrees/terminal-claim-state"
  const serverSockets = new Set<RpcOutboundSocket>()
  const daemon = new DomovoiDaemon({
    port: 0,
    store: new SqliteWorkspaceStore(":memory:", snapshot),
    terminalService: { spawn },
    terminalReapGraceMs,
    rpcOutboundBackpressure: {
      bufferedBytes: (socket) => { serverSockets.add(socket); return socket.bufferedAmount },
    },
    errorSink: vi.fn(),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const connect = async (clientId: string, client = "desktop", authToken = daemon.authToken) => {
    const previousSockets = new Set(serverSockets)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
    sockets.push(socket)
    await once(socket, "open")
    const pending = new Map<number, (reply: Reply) => void>()
    const notifications: Notice[] = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Reply & { id?: number, method?: string, params?: Record<string, unknown> }
      if (message.id !== undefined) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      } else if (message.method?.startsWith("terminal.")) {
        notifications.push({ method: message.method, params: message.params ?? {} })
      }
    })
    let nextId = 0
    const rpc = (method: string, params: Record<string, unknown>) => new Promise<Reply>((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
    expect((await rpc("system.hello", { client, clientId, clientVersion: "0.0.1", protocolVersion, authToken })).error).toBeUndefined()
    const serverSocket = [...serverSockets].find((candidate) => !previousSockets.has(candidate))!
    expect(serverSocket).toBeDefined()
    const identity = { terminalId, client, clientId }
    return {
      socket, serverSocket, rpc, notifications, identity,
      create: (cols = 80, rows = 24) => rpc("terminal.create", { ...identity, sessionId: session.id, cols, rows }),
      claim: () => rpc("terminal.claim", identity),
      release: () => rpc("terminal.release", identity),
      watch: (followResize?: true) => rpc("terminal.watch", { terminalId, ...(followResize ? { followResize } : {}) }),
      resize: (cols = 100, rows = 30) => rpc("terminal.resize", { ...identity, cols, rows }),
      list: () => rpc("terminal.list", { sessionId: session.id }),
      close: async () => { socket.close(); await once(socket, "close") },
    }
  }
  return { daemon, connect, process, spawn, print: (data: string) => print(data), exit: () => exit({ exitCode: 0 }) }
}

const notices = (connection: Connection, method: string) => connection.notifications.filter((notice) => notice.method === method)
const claimedOwner = (clientId: string, claimedAt = firstTime) => ({ client: "desktop", clientId, claimedAt })
const notOwner = { message: "Terminal is owned by another client" }
const waitForResizeBeat = () => new Promise((resolve) => setTimeout(resolve, terminalOutputBatchDelayMilliseconds * 2))

describe("releasing a terminal claim", () => {
  it("announces an unheld live shell, keeps output until unwatch, and refuses former-holder mutations", async () => {
    const { connect, process, print } = await start()
    const owner = await connect("owner")
    const watcher = await connect("watcher")
    const bystander = await connect("bystander")
    expect((await owner.create()).error).toBeUndefined()
    expect((await watcher.watch()).error).toBeUndefined()
    vi.setSystemTime(new Date(nextTime))
    const released = { terminalId, owner: claimedOwner("owner"), claimHeld: false }
    expect(await owner.release()).toMatchObject({ result: released })
    await watcher.list()
    expect(notices(owner, "terminal.ownership")).toEqual([{ method: "terminal.ownership", params: released }])
    expect(notices(watcher, "terminal.ownership")).toEqual([{ method: "terminal.ownership", params: released }])
    expect(await watcher.list()).toMatchObject({ result: { terminals: [{ ...released, state: "live" }] } })
    expect(await watcher.watch()).toMatchObject({ result: released })
    for (const [method, extra] of [["terminal.input", { data: "ls\r" }], ["terminal.resize", { cols: 120, rows: 40 }], ["terminal.close", {}]] as const) {
      expect((await owner.rpc(method, { ...owner.identity, ...extra })).error).toMatchObject(notOwner)
    }
    await new Promise((resolve) => setTimeout(resolve, graceMs * 3))
    expect(process.kill).not.toHaveBeenCalled()
    expect(process.write).not.toHaveBeenCalled()
    expect(process.resize).not.toHaveBeenCalled()
    print("still watching\n")
    await vi.waitFor(() => expect(notices(owner, "terminal.output")).toHaveLength(1), { timeout: 2_000 })
    expect((await owner.rpc("terminal.unwatch", { terminalId })).error).toBeUndefined()
    print("after unwatch\n")
    await vi.waitFor(() => expect(notices(watcher, "terminal.output")).toHaveLength(2), { timeout: 2_000 })
    await owner.list()
    await bystander.list()
    expect(notices(owner, "terminal.output")).toHaveLength(1)
    expect(bystander.notifications).toEqual([])
    vi.setSystemTime(new Date(nextTime))
    expect(await owner.claim()).toMatchObject({ result: { owner: claimedOwner("owner", nextTime), claimHeld: true } })
    expect((await owner.resize()).error).toBeUndefined()
    expect((await owner.rpc("terminal.input", { ...owner.identity, data: "ls\r" })).error).toBeUndefined()
    expect((await owner.rpc("terminal.close", owner.identity)).error).toBeUndefined()
    expect(process.kill).toHaveBeenCalledOnce()
  })

  it("refuses another holder, unknown and closed terminals, and forged paired identity", async () => {
    const { connect, exit } = await start()
    const owner = await connect("owner")
    const other = await connect("other")
    await owner.create()
    expect((await other.release()).error).toMatchObject(notOwner)
    expect((await owner.rpc("terminal.release", { ...owner.identity, terminalId: "unknown" })).error).toMatchObject({ message: "Terminal does not exist" })
    const paired = await owner.rpc("device.pair", { label: "laptop", client: "desktop", targetClient: "desktop", clientAccess: "full" })
    expect(paired.error).toBeUndefined()
    const deviceId = (paired.result?.device as { id: string }).id
    expect((await owner.rpc("terminal.release", { ...owner.identity, clientId: deviceId })).error).toMatchObject({ message: "A request cannot name a paired device's id it did not authenticate as" })
    expect((await owner.watch()).result).toMatchObject({ claimHeld: true, owner: claimedOwner("owner") })
    exit()
    expect((await owner.release()).error).toMatchObject({ message: "Terminal does not exist" })
  })

  it("refuses a phone credential even when it knows the holder identity", async () => {
    const { connect } = await start()
    const owner = await connect("owner")
    await owner.create()
    const paired = await owner.rpc("device.pair", { label: "phone", client: "desktop", targetClient: "phone", clientAccess: "full" })
    expect(paired.error).toBeUndefined()
    const phone = await connect("phone", "phone", paired.result?.token as string)
    expect((await phone.rpc("terminal.release", owner.identity)).error?.message).toMatch(/A phone or tablet credential may only watch sessions/)
    expect((await owner.watch()).result).toMatchObject({ claimHeld: true })
  })

  it("does not retake a released claim at reconnect, key match, or same-client handoff", async () => {
    const { connect, process } = await start()
    const owner = await connect("owner")
    await owner.create()
    const sibling = await connect("owner")
    expect((await owner.release()).error).toBeUndefined()
    expect((await sibling.resize()).error).toMatchObject(notOwner)
    await owner.close()
    const reconnected = await connect("owner")
    await new Promise((resolve) => setTimeout(resolve, graceMs * 3))
    expect((await reconnected.watch()).result).toMatchObject({ state: "live", claimHeld: false, owner: claimedOwner("owner") })
    expect((await reconnected.resize()).error).toMatchObject(notOwner)
    expect(notices(reconnected, "terminal.ownership")).toEqual([])
    expect(process.kill).not.toHaveBeenCalled()
    vi.setSystemTime(new Date(nextTime))
    expect((await reconnected.create()).result).toMatchObject({ owner: claimedOwner("owner", nextTime) })
    expect((await reconnected.resize()).error).toBeUndefined()
  })
})

describe("claim time", () => {
  it("timestamps a new shell and preserves an idempotent claim and create", async () => {
    const { connect } = await start()
    const owner = await connect("owner")
    expect((await owner.create()).result).toMatchObject({ owner: claimedOwner("owner") })
    vi.setSystemTime(new Date(nextTime))
    expect((await owner.claim()).result).toEqual({ terminalId, owner: claimedOwner("owner"), claimHeld: true })
    expect((await owner.create()).result).toMatchObject({ owner: claimedOwner("owner") })
    const other = await connect("other")
    expect((await other.claim()).result).toEqual({ terminalId, owner: claimedOwner("other", nextTime), claimHeld: true })
  })

  it.each(["input", "claim", "create"] as const)("keeps the claim time across same-client %s on a new connection", async (action) => {
    const { connect } = await start()
    const first = await connect("owner")
    await first.create()
    vi.setSystemTime(new Date(nextTime))
    const second = await connect("owner")
    const reply = action === "input"
      ? await second.rpc("terminal.input", { ...second.identity, data: "ls\r" })
      : await second[action]()
    expect(reply.error).toBeUndefined()
    expect((await second.watch()).result).toMatchObject({ owner: claimedOwner("owner"), claimHeld: true })
    await first.list()
    expect(notices(first, "terminal.ownership").at(-1)?.params).toEqual({ terminalId, owner: claimedOwner("owner"), claimHeld: true })
  })

  it.each([true, false])("preserves claim time on disconnect with a sibling already connected: %s", async (hasSibling) => {
    const { connect } = await start({ terminalReapGraceMs: 60_000 })
    const first = await connect("owner")
    await first.create()
    vi.setSystemTime(new Date(nextTime))
    const sibling = hasSibling ? await connect("owner") : undefined
    await first.close()
    const next = sibling ?? await connect("owner")
    await vi.waitFor(() => expect(notices(next, "terminal.ownership").at(-1)?.params).toEqual({ terminalId, owner: claimedOwner("owner"), claimHeld: true }), { timeout: 2_000 })
    expect((await next.watch()).result).toMatchObject({ state: "live", owner: claimedOwner("owner"), claimHeld: true })
  })

  it("timestamps create taking an unheld shell from a different disconnected client and cancels reaping", async () => {
    const reapGraceMs = 60_000
    const { connect, process, spawn } = await start({ terminalReapGraceMs: reapGraceMs })
    const first = await connect("owner")
    const next = await connect("other")
    await first.create()
    const scheduled = vi.spyOn(globalThis, "setTimeout")
    const cancelled = vi.spyOn(globalThis, "clearTimeout")
    await first.close()
    await vi.waitFor(async () => expect((await next.watch()).result).toMatchObject({ state: "live", claimHeld: false }), { timeout: 2_000 })
    const reapIndex = scheduled.mock.calls.findIndex(([, delay]) => delay === reapGraceMs)
    expect(reapIndex).toBeGreaterThanOrEqual(0)
    const reapTimer = scheduled.mock.results[reapIndex]!.value
    expect(reapTimer).toBeDefined()
    expect(cancelled).not.toHaveBeenCalledWith(reapTimer)
    vi.setSystemTime(new Date(nextTime))
    expect((await next.create()).result).toMatchObject({ owner: claimedOwner("other", nextTime) })
    expect(notices(next, "terminal.ownership").at(-1)?.params).toEqual({ terminalId, owner: claimedOwner("other", nextTime), claimHeld: true })
    // Check the exact scheduled reap was cancelled, without sleeping through
    // the grace window or relying on the callback's owner guard to hide a leak.
    expect(cancelled).toHaveBeenCalledWith(reapTimer)
    expect(spawn).toHaveBeenCalledOnce()
    expect(process.kill).not.toHaveBeenCalled()
  })
})

describe("opt-in terminal resize notifications", () => {
  it("sends changed dimensions only to followers, including a phone and a watching credential", async () => {
    const { connect, process } = await start()
    const owner = await connect("owner")
    const legacy = await connect("legacy")
    const follower = await connect("follower")
    const bystander = await connect("bystander")
    const restricted = []
    for (const [client, clientAccess] of [["phone", "full"], ["desktop", "watching"]] as const) {
      const paired = await owner.rpc("device.pair", { label: client, client: "desktop", targetClient: client, clientAccess })
      expect(paired.error).toBeUndefined()
      restricted.push(await connect(client, client, paired.result?.token as string))
    }
    await owner.create()
    expect((await legacy.watch()).error).toBeUndefined()
    for (const connection of [follower, ...restricted]) expect((await connection.watch(true)).error).toBeUndefined()
    expect((await owner.resize()).error).toBeUndefined()
    await waitForResizeBeat()
    for (const connection of [owner, legacy, follower, bystander, ...restricted]) await connection.list()
    const resized = { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } }
    for (const connection of [follower, ...restricted]) expect(notices(connection, "terminal.resized")).toEqual([resized])
    for (const connection of [owner, legacy, bystander]) expect(notices(connection, "terminal.resized")).toEqual([])
    expect(process.resize).toHaveBeenCalledWith(100, 30)

    // Both resize entrypoints suppress unchanged grids, then report row-only
    // and column-only changes. A non-holder's create does not resize.
    await owner.resize()
    await owner.create(100, 30)
    await legacy.create(150, 40)
    await waitForResizeBeat()
    await follower.list()
    expect(notices(follower, "terminal.resized")).toEqual([resized])
    await owner.create(100, 31)
    await waitForResizeBeat()
    await owner.resize(101, 31)
    await waitForResizeBeat()
    await follower.list()
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([
      { terminalId, cols: 100, rows: 30 },
      { terminalId, cols: 100, rows: 31 },
      { terminalId, cols: 101, rows: 31 },
    ])
  })

  it("uses the latest watch and removes resize following on unwatch even for the holder", async () => {
    const { connect, print } = await start()
    const owner = await connect("owner")
    const follower = await connect("follower")
    await owner.create()
    await follower.watch(true)
    await follower.watch()
    await owner.resize()
    await waitForResizeBeat()
    await follower.list()
    expect(notices(follower, "terminal.resized")).toEqual([])
    await follower.watch(true)
    await owner.watch(true)
    await owner.resize(101, 30)
    await waitForResizeBeat()
    await follower.list()
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
    expect(notices(owner, "terminal.resized")).toHaveLength(1)
    for (const connection of [owner, follower]) expect((await connection.rpc("terminal.unwatch", { terminalId })).error).toBeUndefined()
    await owner.resize(102, 30)
    await waitForResizeBeat()
    print("owner still reads\n")
    await vi.waitFor(() => expect(notices(owner, "terminal.output")).toHaveLength(1), { timeout: 2_000 })
    await follower.list()
    for (const connection of [owner, follower]) expect(notices(connection, "terminal.resized")).toHaveLength(1)
    expect(notices(follower, "terminal.output")).toEqual([])
  })

  it("does not carry following across disconnect and same-client reattachment", async () => {
    const { connect } = await start()
    const first = await connect("owner")
    await first.create()
    await first.watch(true)
    const sibling = await connect("owner")
    await first.close()
    await vi.waitFor(() => expect(notices(sibling, "terminal.ownership")).toHaveLength(1), { timeout: 2_000 })
    await sibling.resize()
    await waitForResizeBeat()
    expect(notices(sibling, "terminal.resized")).toEqual([])
    const next = await connect("owner")
    await next.watch()
    await sibling.resize(110, 30)
    await waitForResizeBeat()
    await next.list()
    expect(notices(next, "terminal.resized")).toEqual([])
    await next.watch(true)
    await sibling.resize(120, 30)
    await waitForResizeBeat()
    await next.list()
    expect(notices(next, "terminal.resized")).toHaveLength(1)
  })

  it("accepts following a closed record without subscribing to a later shell with that id", async () => {
    const { connect, exit } = await start()
    const owner = await connect("owner")
    const follower = await connect("follower")
    await owner.create()
    exit()
    expect((await follower.watch(true)).result).toMatchObject({ state: "closed", claimHeld: false })
    await owner.create()
    await owner.resize()
    await waitForResizeBeat()
    await follower.list()
    expect(follower.notifications).toEqual([])
  })
})

describe("bounded terminal resize delivery", () => {
  async function setup() {
    const harness = await start()
    const owner = await harness.connect("owner")
    const follower = await harness.connect("follower")
    await owner.create()
    await follower.watch(true)
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    const beat = async () => {
      await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds)
      // A reply follows notifications already sent on this connection.
      await owner.list()
    }
    return { ...harness, owner, follower, beat }
  }

  it("keeps a synchronous create redraw live and outside a same-client replay reply", async () => {
    const { connect, follower, process, print, beat } = await setup()
    const next = await connect("owner")
    print("old grid\n")
    process.resize.mockImplementation(() => print("new grid\n"))
    const reply = await next.create(100, 30)
    expect(reply.result).toMatchObject({ cols: 100, rows: 30, buffer: "old grid\n" })
    expect(process.resize).toHaveBeenCalledExactlyOnceWith(100, 30)
    await beat()
    await beat()
    await next.list()
    await follower.list()
    expect(notices(next, "terminal.output").map(({ params }) => params.data)).toEqual(["new grid\n"])
    expect(follower.notifications.filter(({ method }) => method !== "terminal.ownership")).toEqual([
      { method: "terminal.output", params: { terminalId, data: "old grid\n" } },
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
      { method: "terminal.output", params: { terminalId, data: "new grid\n" } },
    ])
    const seen = `${reply.result?.buffer}${notices(next, "terminal.output").map(({ params }) => params.data).join("")}`
    expect(seen.split("new grid\n")).toHaveLength(2)
  })

  it("keeps the stream paused after a claim drains pending output, until low water", async () => {
    const { connect, follower, process, print, beat } = await setup()
    const claimant = await connect("claimant")
    const unrelated = await connect("slow-unrelated")
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(unrelated.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    print("pending\n")
    expect((await claimant.claim()).error).toBeUndefined()
    expect(process.pause).toHaveBeenCalledOnce()
    expect((await claimant.resize()).error).toBeUndefined()
    await follower.list()
    expect(notices(follower, "terminal.output").map(({ params }) => params.data)).toEqual(["pending\n"])
    expect(notices(follower, "terminal.resized")).toEqual([])
    await beat()
    expect(process.resume).not.toHaveBeenCalled()
    bufferedBytes = 0
    await beat()
    await follower.list()
    expect(process.resume).toHaveBeenCalledOnce()
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([{ terminalId, cols: 100, rows: 30 }])
    await beat()
    await follower.list()
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
  })

  it("delivers pending output once to a same-client connection taking ownership through input", async () => {
    const { connect, print, beat } = await setup()
    const next = await connect("owner")
    print("pending before input\n")
    expect((await next.rpc("terminal.input", { ...next.identity, data: "x" })).error).toBeUndefined()
    expect(notices(next, "terminal.output").map(({ params }) => params.data)).toEqual(["pending before input\n"])
    await beat()
    await beat()
    await next.list()
    expect(notices(next, "terminal.output").map(({ params }) => params.data)).toEqual(["pending before input\n"])
  })

  async function pausedJoin() {
    const harness = await setup()
    const slow = await harness.connect("slow-unrelated")
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(slow.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    const historyTime = new Date().toISOString()
    harness.print("history\n")
    await harness.beat()
    await harness.follower.list()
    expect(harness.process.pause).toHaveBeenCalledOnce()
    harness.owner.notifications.length = 0
    harness.follower.notifications.length = 0
    return { ...harness, historyTime, drain: () => { bufferedBytes = 0 } }
  }

  it.each(["new", "existing"] as const)("keeps a paused %s watcher replay separate from queued output and markers", async (membership) => {
    const { connect, owner, follower, process, print, beat, drain, historyTime } = await pausedJoin()
    const joiner = membership === "new" ? await connect("joiner") : follower
    print("q1")
    await beat()
    await owner.resize()
    const reply = await joiner.watch(true)
    expect(reply.result).toMatchObject({ cols: 80, rows: 24, buffer: "history\n", bufferStartsAt: historyTime, earlierOutputDropped: false })
    await follower.list()
    expect(joiner.notifications).toEqual([])
    expect(follower.notifications).toEqual([])
    expect(owner.notifications).toEqual([])
    expect(process.resume).not.toHaveBeenCalled()
    drain()
    await beat()
    await joiner.list()
    await follower.list()
    const events = [
      { method: "terminal.output", params: { terminalId, data: "q1" } },
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
    ]
    expect(joiner.notifications).toEqual(events)
    expect(follower.notifications).toEqual(events)
    expect(owner.notifications).toEqual(events.slice(0, 1))
    await beat()
    await joiner.list()
    expect(joiner.notifications).toEqual(events)
  })

  it.each([true, false])("starts a paused follower at the queued grid (follower at resize: %s)", async (hadFollower) => {
    const { connect, owner, follower, print, beat, drain } = await pausedJoin()
    if (!hadFollower) await follower.watch()
    print("old\n")
    await owner.resize(100, 30)
    const joiner = await connect("joiner")
    const reply = await joiner.watch(true)
    expect.soft(reply.result).toMatchObject({ cols: 80, rows: 24, buffer: "history\n" })
    expect(joiner.notifications).toEqual([])
    drain()
    await beat()
    await joiner.list()
    await follower.list()
    const events = [
      { method: "terminal.output", params: { terminalId, data: "old\n" } },
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
    ]
    expect.soft(joiner.notifications).toEqual(events)
    expect(follower.notifications).toEqual(hadFollower ? events : events.slice(0, 1))
    await beat()
    await joiner.list()
    expect(joiner.notifications).toEqual(events)
  })

  it("reports current dimensions to a paused non-follower", async () => {
    const { connect, owner, print } = await pausedJoin()
    print("old\n")
    await owner.resize(100, 30)
    const joiner = await connect("joiner")
    expect((await joiner.watch()).result).toMatchObject({ cols: 100, rows: 30, buffer: "history\n" })
    expect(joiner.notifications).toEqual([])
  })

  it.each([false, true])("starts a paused follower create at the queued grid (prior resize: %s)", async (priorResize) => {
    const { owner, print, beat, drain } = await pausedJoin()
    await owner.watch(true)
    print("old\n")
    if (priorResize) await owner.resize(90, 27)
    expect((await owner.create(100, 30)).result).toMatchObject({ cols: 80, rows: 24, buffer: "history\n" })
    expect(owner.notifications).toEqual([])
    drain()
    await beat()
    const events = [
      { method: "terminal.output", params: { terminalId, data: "old\n" } },
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
    ]
    expect(owner.notifications).toEqual(events)
    await beat()
    expect(owner.notifications).toEqual(events)
  })

  it("keeps five resize and watch rounds paused and coalesces their markers", async () => {
    const { owner, follower, process, beat, drain } = await pausedJoin()
    for (let round = 0; round < 5; round += 1) {
      await owner.resize(100 + round, 30)
      await follower.watch(true)
    }
    expect.soft(notices(follower, "terminal.resized")).toEqual([])
    expect(process.resume).not.toHaveBeenCalled()
    drain()
    await beat()
    await follower.list()
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([{ terminalId, cols: 104, rows: 30 }])
  })

  it.each(["existing", "new", "reconnected", "unheld"] as const)("keeps a paused create separate from queued output for a client that is %s", async (membership) => {
    const { connect, owner, follower, print, beat, drain } = await pausedJoin()
    const joiner = membership === "existing" ? owner : await connect(membership === "reconnected" ? "owner" : "joiner")
    print("q1")
    await beat()
    expect((await owner.resize()).error).toBeUndefined()
    if (membership === "unheld") await owner.release()
    const reply = await joiner.create(100, 30)
    expect(reply.result?.buffer).toBe("history\n")
    await follower.list()
    expect(notices(joiner, "terminal.output")).toEqual([])
    expect(notices(follower, "terminal.output")).toEqual([])
    expect(notices(follower, "terminal.resized")).toEqual([])
    drain()
    await beat()
    await joiner.list()
    await follower.list()
    expect(notices(joiner, "terminal.output").map(({ params }) => params.data)).toEqual(["q1"])
    expect(notices(follower, "terminal.output").map(({ params }) => params.data)).toEqual(["q1"])
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([{ terminalId, cols: 100, rows: 30 }])
    expect(`${reply.result?.buffer}${notices(joiner, "terminal.output").map(({ params }) => params.data).join("")}`).toBe("history\nq1")
  })

  it.each(["claim", "input", "disconnect"] as const)("keeps the stream paused when a new connection joins through %s", async (method) => {
    const { connect, owner, follower, print, beat, drain } = await pausedJoin()
    const joiner = await connect(method === "claim" ? "claimant" : "owner")
    print("q1")
    await beat()
    await owner.resize()
    if (method === "disconnect") await owner.close()
    else {
      const reply = method === "claim" ? await joiner.claim() : await joiner.rpc("terminal.input", { ...joiner.identity, data: "x" })
      expect(reply.error).toBeUndefined()
    }
    await joiner.list()
    await follower.list()
    expect(notices(joiner, "terminal.output")).toEqual([])
    expect(notices(follower, "terminal.output")).toEqual([])
    expect(notices(follower, "terminal.resized")).toEqual([])
    drain()
    await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds)
    await joiner.list()
    await follower.list()
    expect(notices(joiner, "terminal.output").map(({ params }) => params.data)).toEqual(["q1"])
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([{ terminalId, cols: 100, rows: 30 }])
  })

  it.each([false, true])("omits a paused replay timestamp when all retained text is queued (overflow: %s)", async (overflow) => {
    const { connect, owner, follower, print, beat } = await setup()
    // Pause with a resize, leaving the replay empty before queuing text.
    const slow = await connect("slow-unrelated")
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(slow.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    await owner.resize()
    await follower.list()
    const text = overflow ? `${"x".repeat(maximumTerminalReplayCharacters + 1)}\n` : "q1\n"
    print(text)
    const joiner = await connect("joiner")
    const reply = await joiner.watch(true)
    expect(reply.result?.buffer).toHaveLength(0)
    expect(reply.result?.earlierOutputDropped).toBe(overflow)
    expect(reply.result).not.toHaveProperty("bufferStartsAt")
    expect(joiner.notifications).toEqual([])
    bufferedBytes = 0
    await beat()
    await joiner.list()
    expect(notices(joiner, "terminal.output").map(({ params }) => params.data).join("")).toBe(text)
  })

  it.each(["resize", "create"] as const)("orders a %s marker before a synchronous PTY redraw and after queued old output", async (method) => {
    const { owner, follower, process, print, beat } = await setup()
    print("old grid\n")
    process.resize.mockImplementation(() => print("new grid\n"))
    expect((await owner[method](100, 30)).error).toBeUndefined()
    await beat()
    await follower.list()
    expect(follower.notifications).toEqual([
      { method: "terminal.output", params: { terminalId, data: "old grid\n" } },
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
      { method: "terminal.output", params: { terminalId, data: "new grid\n" } },
    ])
  })

  it.each(["plain", "none"] as const)("does not observe resize backpressure with %s watchers and a slow unrelated client", async (watch) => {
    const { connect, owner, follower, process, beat } = await setup()
    if (watch === "plain") await follower.watch()
    else await follower.rpc("terminal.unwatch", { terminalId })
    const unrelated = await connect("unrelated")
    Object.defineProperty(unrelated.serverSocket, "bufferedAmount", { get: () => terminalWebSocketHighWaterBytes + 1 })
    const observed = vi.spyOn(TerminalOutputBackpressure.prototype, "observe")
    await owner.resize()
    await beat()
    await owner.create(120, 40)
    await beat()
    await follower.list()
    expect(observed).not.toHaveBeenCalled()
    expect(process.pause).not.toHaveBeenCalled()
    expect(notices(follower, "terminal.resized")).toEqual([])
  })

  it.each(["plain", "none"] as const)("keeps pending prompt output on its batch beat with %s watchers", async (watch) => {
    const { connect, owner, follower, process, print, beat } = await setup()
    if (watch === "plain") await follower.watch()
    else await follower.rpc("terminal.unwatch", { terminalId })
    const slow = await connect("slow-unrelated")
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(slow.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    const observed = vi.spyOn(TerminalOutputBackpressure.prototype, "observe")
    print("prompt before resize")
    await owner.resize()
    expect.soft(owner.notifications).toEqual([])
    expect.soft(observed).not.toHaveBeenCalled()
    expect.soft(process.pause).not.toHaveBeenCalled()
    await beat()
    expect(notices(owner, "terminal.output").map(({ params }) => params.data)).toEqual(["prompt before "])
    expect(observed).toHaveBeenCalledOnce()
    expect(process.pause).toHaveBeenCalledOnce()
    bufferedBytes = 0
    await beat()
    await beat()
    expect(notices(owner, "terminal.output").map(({ params }) => params.data)).toEqual(["prompt before ", "resize"])
    expect(notices(owner, "terminal.resized")).toEqual([])
    expect(observed).toHaveBeenCalledTimes(2)
  })

  it("does not start an output batch clock for a resize without followers", async () => {
    const { owner, follower, print } = await setup()
    await follower.watch()
    await owner.resize()
    await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
    print("new grid\n")
    await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
    await owner.list()
    expect(owner.notifications).toEqual([])
    await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
    await owner.list()
    expect(notices(owner, "terminal.output").map(({ params }) => params.data)).toEqual(["new grid\n"])
  })

  it("batches output on both sides of a resize without followers until the beat", async () => {
    const { owner, follower, process, print, beat } = await setup()
    await follower.watch()
    const observed = vi.spyOn(TerminalOutputBackpressure.prototype, "observe")
    print("old\n")
    process.resize.mockImplementation(() => print("new\n"))
    await owner.resize()
    expect(owner.notifications).toEqual([])
    expect(observed).not.toHaveBeenCalled()
    await beat()
    // Keep the grid boundary, even though no reader currently receives its marker.
    expect(notices(owner, "terminal.output").map(({ params }) => params.data)).toEqual(["old\n", "new\n"])
    expect(notices(owner, "terminal.resized")).toEqual([])
    expect(observed).toHaveBeenCalledTimes(2)
    await beat()
    expect(notices(owner, "terminal.output")).toHaveLength(2)
  })

  it.each(["resize", "create"] as const)("queues one latest %s marker while paused before output drawn afterward", async (method) => {
    const { owner, follower, process, print, beat } = await setup()
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(follower.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    print("old grid\n")
    await beat()
    expect(process.pause).toHaveBeenCalledOnce()
    for (let index = 0; index < 10; index += 1) await owner[method](100 + index, 30)
    print("new grid\n")
    await beat()
    await beat()
    expect(follower.notifications).toEqual([{ method: "terminal.output", params: { terminalId, data: "old grid\n" } }])
    bufferedBytes = 0
    await beat()
    await follower.list()
    expect(follower.notifications).toEqual([
      { method: "terminal.output", params: { terminalId, data: "old grid\n" } },
      { method: "terminal.resized", params: { terminalId, cols: 109, rows: 30 } },
      { method: "terminal.output", params: { terminalId, data: "new grid\n" } },
    ])
  })

  it("skips observation when the last follower leaves before a queued marker drains", async () => {
    const { connect, owner, follower, print, beat } = await setup()
    const unrelated = await connect("unrelated")
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(unrelated.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    print("old grid\n")
    await beat()
    await owner.resize()
    await follower.rpc("terminal.unwatch", { terminalId })
    const observed = vi.spyOn(TerminalOutputBackpressure.prototype, "observe")
    bufferedBytes = 0
    await beat()
    await follower.list()
    expect(observed).not.toHaveBeenCalled()
    expect(notices(follower, "terminal.resized")).toEqual([])
  })

  it.each(["resize", "create"] as const)("holds a large synchronous redraw after a %s marker pauses the stream", async (method) => {
    const { owner, follower, process, print, beat } = await setup()
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(follower.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    const redraw = `${"x".repeat(maximumTerminalOutputChunkCharacters * 2)}\n`
    process.resize.mockImplementation(() => print(redraw))
    await owner[method](100, 30)
    await beat()
    expect(process.pause).toHaveBeenCalledOnce()
    expect(follower.notifications).toEqual([
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
    ])
    bufferedBytes = 0
    await beat()
    await follower.list()
    expect(follower.notifications[0]?.method).toBe("terminal.resized")
    expect(notices(follower, "terminal.output").map(({ params }) => params.data).join("")).toBe(redraw)
  })

  it.each(["resize", "create"] as const)("sends each unpaused holder %s boundary immediately without deferred duplicates", async (method) => {
    const { owner, follower, beat } = await setup()
    for (let index = 0; index < 10; index += 1) expect((await owner[method](100 + index, 30)).error).toBeUndefined()
    await follower.list()
    const sizes = Array.from({ length: 10 }, (_, index) => ({ terminalId, cols: 100 + index, rows: 30 }))
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual(sizes)
    await beat()
    await beat()
    await follower.list()
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual(sizes)
  })

  it("holds only the latest size while paused and sends it once at low water", async () => {
    const { owner, follower, process, print, beat } = await setup()
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(follower.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    print("output fills the socket\n")
    await beat()
    expect(process.pause).toHaveBeenCalledOnce()
    for (let index = 0; index < 10; index += 1) await owner.resize(100 + index, 30)
    await beat()
    await beat()
    // Use the healthy holder as the barrier; a response to the slow watcher
    // would correctly take the ordinary RPC high-water close path.
    expect(notices(follower, "terminal.resized")).toEqual([])
    bufferedBytes = 0
    await beat()
    await follower.list()
    expect(process.resume).toHaveBeenCalledOnce()
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([{ terminalId, cols: 109, rows: 30 }])
    await beat()
    await follower.list()
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
  })

  it.each([
    { data: "before resize\n", released: "before resize\n", retained: "" },
    { data: "prompt before resize", released: "prompt before ", retained: "resize" },
  ])("orders already-redacted output before the size and retained text after it: $data", async ({ data, released, retained }) => {
    const { owner, follower, print, beat } = await setup()
    print(data)
    await owner.resize()
    await follower.list()
    expect(follower.notifications).toEqual([
      { method: "terminal.output", params: { terminalId, data: released } },
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
    ])
    await beat()
    await beat()
    await follower.list()
    expect(follower.notifications.slice(2)).toEqual(retained
      ? [{ method: "terminal.output", params: { terminalId, data: retained } }]
      : [])
    expect(notices(follower, "terminal.output").map(({ params }) => params.data).join("")).toBe(data)
  })

  it("pauses resize-only traffic when a resize fills the follower buffer", async () => {
    const { owner, follower, process, beat } = await setup()
    let bufferedBytes = terminalWebSocketHighWaterBytes - 1
    Object.defineProperty(follower.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    const send = follower.serverSocket.send.bind(follower.serverSocket)
    vi.spyOn(follower.serverSocket, "send").mockImplementation((message) => {
      send(message)
      bufferedBytes += Buffer.byteLength(message)
    })
    await owner.resize()
    await beat()
    expect(process.pause).toHaveBeenCalledOnce()
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
    for (let index = 0; index < 10; index += 1) await owner.resize(110 + index, 30)
    await beat()
    await beat()
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
    bufferedBytes = 0
    await beat()
    await follower.list()
    expect(process.resume).toHaveBeenCalledOnce()
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([
      { terminalId, cols: 100, rows: 30 },
      { terminalId, cols: 119, rows: 30 },
    ])
  })

  it("sends the resize immediately while fragments still wait for the quiet redactor beat", async () => {
    const { owner, follower, print, beat } = await setup()
    print("hel")
    await owner.resize()
    await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
    print("lo")
    await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
    await follower.list()
    expect(follower.notifications).toEqual([
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
    ])

    await beat()
    await beat()
    await follower.list()
    const afterResize = follower.notifications.slice(1)
    expect(afterResize.every(({ method }) => method === "terminal.output")).toBe(true)
    expect(afterResize.map(({ params }) => params.data).join("")).toBe("hello")
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
  })

  it("delivers each unpaused resize without waiting for quiet during continuous output", async () => {
    const { owner, follower, print, beat } = await setup()
    print("continuous")
    await owner.resize()
    await follower.list()
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([{ terminalId, cols: 100, rows: 30 }])
    for (let halfBeat = 1; halfBeat <= 10; halfBeat += 1) {
      await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
      print("x")
      if (halfBeat === 3) await owner.resize(120, 40)
      if (halfBeat === 7) await owner.resize(140, 50)
      await follower.list()
      expect(notices(follower, "terminal.resized")).toHaveLength(halfBeat < 3 ? 1 : halfBeat < 7 ? 2 : 3)
    }
    expect(notices(follower, "terminal.resized").map(({ params }) => params)).toEqual([
      { terminalId, cols: 100, rows: 30 },
      { terminalId, cols: 120, rows: 40 },
      { terminalId, cols: 140, rows: 50 },
    ])
    await beat()
    await beat()
    await follower.list()
    expect(notices(follower, "terminal.resized")).toHaveLength(3)
    expect(notices(follower, "terminal.output").map(({ params }) => params.data).join("")).toBe(`continuous${"x".repeat(10)}`)

    print("another")
    await owner.resize(150, 60)
    await follower.list()
    expect(notices(follower, "terminal.resized").at(-1)?.params).toEqual({ terminalId, cols: 150, rows: 60 })
    for (let halfBeat = 1; halfBeat <= 10; halfBeat += 1) {
      await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
      print("x")
      await follower.list()
      expect(notices(follower, "terminal.resized")).toHaveLength(4)
    }
    await beat()
    await beat()
    await follower.list()
    expect(notices(follower, "terminal.output").map(({ params }) => params.data).join("")).toBe(`continuous${"x".repeat(10)}another${"x".repeat(10)}`)
  })

  it("can deliver a complete line retained by the redactor after an immediate resize", async () => {
    const { owner, follower, print, beat } = await setup()
    const heldLine = "API_KEY\n"
    print(heldLine)
    await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
    print(" ")
    await owner.resize()

    // Whitespace can continue an assignment across a newline, so the redactor
    // retains this complete line while fragments keep postponing its quiet beat.
    for (let halfBeat = 1; halfBeat <= 10; halfBeat += 1) {
      await vi.advanceTimersByTimeAsync(terminalOutputBatchDelayMilliseconds / 2)
      print(" ")
      await follower.list()
      expect(notices(follower, "terminal.resized")).toHaveLength(1)
    }
    expect(follower.notifications).toEqual([
      { method: "terminal.resized", params: { terminalId, cols: 100, rows: 30 } },
    ])

    // Once output becomes quiet, the retained line follows the size. The
    // ordering limit concerns all retained text, not just an unterminated tail.
    await beat()
    await beat()
    await follower.list()
    const afterResize = follower.notifications.slice(1)
    expect(afterResize.every(({ method }) => method === "terminal.output")).toBe(true)
    expect(afterResize.map(({ params }) => params.data).join("")).toBe(`${heldLine}${" ".repeat(11)}`)
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
  })

  it.each(["close", "exit"] as const)("flushes the paused resize before the terminal ends by %s", async (end) => {
    const { owner, follower, process, print, exit, beat } = await setup()
    let bufferedBytes = terminalWebSocketHighWaterBytes + 1
    Object.defineProperty(follower.serverSocket, "bufferedAmount", { get: () => bufferedBytes })
    print("old grid\n")
    await beat()
    expect(process.pause).toHaveBeenCalledOnce()
    await owner.resize()
    expect(notices(follower, "terminal.resized")).toEqual([])
    // End before the low-water beat can resume the queued stream.
    bufferedBytes = 0
    if (end === "close") expect((await owner.rpc("terminal.close", owner.identity)).error).toBeUndefined()
    else exit()
    await beat()
    await follower.list()
    expect(follower.notifications.map(({ method }) => method)).toEqual(["terminal.output", "terminal.resized", "terminal.closed"])
    expect(notices(follower, "terminal.resized")[0]?.params).toEqual({ terminalId, cols: 100, rows: 30 })
  })
})
