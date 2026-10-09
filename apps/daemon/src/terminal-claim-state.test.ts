import { once } from "node:events"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { TerminalProcess } from "./terminal.js"

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
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  vi.useRealTimers()
})

async function start() {
  // Keep network and reap timers real; only the claim clock is controlled.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(firstTime))
  let print = (_data: string) => {}
  let exit = (_event: { exitCode: number }) => {}
  const process = {
    process: "zsh", write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((listener: typeof print) => { print = listener; return { dispose: vi.fn() } }),
    onExit: vi.fn((listener: typeof exit) => { exit = listener; return { dispose: vi.fn() } }),
  } satisfies TerminalProcess
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.workspacePath = "/worktrees/terminal-claim-state"
  const daemon = new DomovoiDaemon({
    port: 0,
    store: new SqliteWorkspaceStore(":memory:", snapshot),
    terminalService: { spawn: vi.fn(() => process) },
    terminalReapGraceMs: graceMs,
    errorSink: vi.fn(),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const connect = async (clientId: string, client = "desktop", authToken = daemon.authToken) => {
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
    const identity = { terminalId, client, clientId }
    return {
      socket, rpc, notifications, identity,
      create: (cols = 80, rows = 24) => rpc("terminal.create", { ...identity, sessionId: session.id, cols, rows }),
      claim: () => rpc("terminal.claim", identity),
      release: () => rpc("terminal.release", identity),
      watch: (followResize?: true) => rpc("terminal.watch", { terminalId, ...(followResize ? { followResize } : {}) }),
      resize: (cols = 100, rows = 30) => rpc("terminal.resize", { ...identity, cols, rows }),
      list: () => rpc("terminal.list", { sessionId: session.id }),
      close: async () => { socket.close(); await once(socket, "close") },
    }
  }
  return { daemon, connect, process, print: (data: string) => print(data), exit: () => exit({ exitCode: 0 }) }
}

const notices = (connection: Connection, method: string) => connection.notifications.filter((notice) => notice.method === method)
const claimedOwner = (clientId: string, claimedAt = firstTime) => ({ client: "desktop", clientId, claimedAt })
const notOwner = { message: "Terminal is owned by another client" }

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
    await vi.waitFor(() => expect(notices(owner, "terminal.output")).toHaveLength(1))
    expect((await owner.rpc("terminal.unwatch", { terminalId })).error).toBeUndefined()
    print("after unwatch\n")
    await vi.waitFor(() => expect(notices(watcher, "terminal.output")).toHaveLength(2))
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
    expect((await reconnected.watch()).result).toMatchObject({ claimHeld: false, owner: claimedOwner("owner") })
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
    const { connect } = await start()
    const first = await connect("owner")
    await first.create()
    vi.setSystemTime(new Date(nextTime))
    const sibling = hasSibling ? await connect("owner") : undefined
    await first.close()
    const next = sibling ?? await connect("owner")
    await vi.waitFor(() => expect(notices(next, "terminal.ownership").at(-1)?.params).toEqual({ terminalId, owner: claimedOwner("owner"), claimHeld: true }))
    expect((await next.watch()).result).toMatchObject({ owner: claimedOwner("owner"), claimHeld: true })
  })

  it("timestamps create taking an unheld shell from a different disconnected client and cancels reaping", async () => {
    const { connect, process } = await start()
    const first = await connect("owner")
    const next = await connect("other")
    await first.create()
    await first.close()
    await vi.waitFor(async () => expect((await next.watch()).result).toMatchObject({ claimHeld: false }))
    vi.setSystemTime(new Date(nextTime))
    expect((await next.create()).result).toMatchObject({ owner: claimedOwner("other", nextTime) })
    expect(notices(next, "terminal.ownership").at(-1)?.params).toEqual({ terminalId, owner: claimedOwner("other", nextTime), claimHeld: true })
    await new Promise((resolve) => setTimeout(resolve, graceMs * 3))
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
    await follower.list()
    expect(notices(follower, "terminal.resized")).toEqual([resized])
    await owner.create(100, 31)
    await owner.resize(101, 31)
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
    await follower.list()
    expect(notices(follower, "terminal.resized")).toEqual([])
    await follower.watch(true)
    await owner.watch(true)
    await owner.resize(101, 30)
    await follower.list()
    expect(notices(follower, "terminal.resized")).toHaveLength(1)
    expect(notices(owner, "terminal.resized")).toHaveLength(1)
    for (const connection of [owner, follower]) expect((await connection.rpc("terminal.unwatch", { terminalId })).error).toBeUndefined()
    await owner.resize(102, 30)
    print("owner still reads\n")
    await vi.waitFor(() => expect(notices(owner, "terminal.output")).toHaveLength(1))
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
    await vi.waitFor(() => expect(notices(sibling, "terminal.ownership")).toHaveLength(1))
    await sibling.resize()
    expect(notices(sibling, "terminal.resized")).toEqual([])
    const next = await connect("owner")
    await next.watch()
    await sibling.resize(110, 30)
    await next.list()
    expect(notices(next, "terminal.resized")).toEqual([])
    await next.watch(true)
    await sibling.resize(120, 30)
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
    await follower.list()
    expect(follower.notifications).toEqual([])
  })
})
