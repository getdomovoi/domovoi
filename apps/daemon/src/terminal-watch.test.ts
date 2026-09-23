import { once } from "node:events"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { TerminalProcess } from "./terminal.js"
import { waitForDaemon } from "./test-wait-for.js"

// Phone v2 frame 04: a phone or tablet reads the shell, and only the device
// holding the claim types into it. The read is terminal.list, terminal.watch
// and terminal.unwatch. Output goes to the connections that opened, claimed
// or watched a terminal, and to no one else.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

let nextId = 1

type Connection = {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
  notifications: Array<{ method: string; params: unknown }>
  close(): void
}

async function connect(daemon: DomovoiDaemon): Promise<Connection> {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const notifications: Connection["notifications"] = []
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (typeof message.id === "number") pending.get(message.id)?.(message)
    else if (typeof message.method === "string") notifications.push({ method: message.method, params: message.params })
  })
  return {
    notifications,
    call(method, params) {
      const id = nextId++
      const reply = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return reply
    },
    close: () => socket.close(),
  }
}

function outputs(connection: Connection): string[] {
  return connection.notifications
    .filter(({ method }) => method === "terminal.output")
    .map(({ params }) => (params as { data: string }).data)
}

function terminalMethods(connection: Connection): string[] {
  return connection.notifications.map(({ method }) => method).filter((method) => method.startsWith("terminal."))
}

const hello = (client: string, clientId: string, authToken: string) =>
  ({ client, clientId, clientVersion: "0.0.1", protocolVersion, authToken })

async function start(options: { terminalClosedRetentionMs?: number, terminalClosedRetentionCharacters?: number } = {}) {
  let print: (data: string) => void = () => {}
  let exit: (event: { exitCode: number, signal?: number }) => void = () => {}
  const process = {
    process: "zsh",
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      print = listener
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn((listener: (event: { exitCode: number, signal?: number }) => void) => {
      exit = listener
      return { dispose: vi.fn() }
    }),
  } satisfies TerminalProcess
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.workspacePath = "/worktrees/wt-billing-idem"
  const daemon = new DomovoiDaemon({
    port: 0,
    store: new SqliteWorkspaceStore(":memory:", snapshot),
    terminalService: { spawn: vi.fn(() => process) },
    ...options,
  })
  daemons.push(daemon)
  await daemon.start()
  const owner = await connect(daemon)
  expect(await owner.call("system.hello", hello("desktop", "desktop-owner", daemon.authToken))).not.toHaveProperty("error")
  const pair = async (targetClient: "phone" | "tablet" | "desktop", clientAccess: "full" | "watching") => {
    const minted = await owner.call("device.pair", { label: `${targetClient} ${clientAccess}`, client: "desktop", targetClient, clientAccess })
    expect(minted).not.toHaveProperty("error")
    const connection = await connect(daemon)
    const token = (minted.result as { token: string }).token
    expect(await connection.call("system.hello", hello(targetClient, `${targetClient}-${clientAccess}`, token))).not.toHaveProperty("error")
    return connection
  }
  return { daemon, session, process, print: (data: string) => print(data), exit: (event: { exitCode: number, signal?: number }) => exit(event), owner, pair }
}

describe("a phone reading a terminal", () => {
  it("lists a session's terminals, watches one for its record and live output, and never types", async () => {
    const { session, print, owner, pair, process } = await start()
    const phone = await pair("phone", "full")

    expect(await phone.call("terminal.list", { sessionId: session.id })).toMatchObject({ result: { terminals: [] } })

    const create = { terminalId: "terminal-1", sessionId: session.id, cols: 120, rows: 34, client: "desktop", clientId: "desktop-owner" }
    expect(await owner.call("terminal.create", create)).not.toHaveProperty("error")
    print("$ pnpm vitest run src/webhooks\r\n")
    await waitForDaemon(() => expect(outputs(owner)).toEqual(["$ pnpm vitest run src/webhooks\r\n"]))
    // Output printed before the watch never reaches the phone as a notification.
    expect(terminalMethods(phone)).toEqual([])

    const listed = await phone.call("terminal.list", { sessionId: session.id })
    expect(listed.result).toEqual({
      terminals: [{
        terminalId: "terminal-1", sessionId: session.id, cols: 120, rows: 34, shell: "zsh", cwd: "/worktrees/wt-billing-idem",
        owner: { client: "desktop", clientId: "desktop-owner" }, claimHeld: true, openedAt: expect.any(String), state: "live",
      }],
    })
    expect((listed.result as { terminals: Record<string, unknown>[] }).terminals[0]).not.toHaveProperty("buffer")
    expect(await phone.call("terminal.list", { sessionId: "another-session" })).toMatchObject({ result: { terminals: [] } })

    const watched = await phone.call("terminal.watch", { terminalId: "terminal-1" })
    expect(watched.result).toMatchObject({
      terminalId: "terminal-1", sessionId: session.id, cols: 120, rows: 34, shell: "zsh",
      owner: { client: "desktop", clientId: "desktop-owner" }, claimHeld: true, state: "live",
      buffer: "$ pnpm vitest run src/webhooks\r\n", earlierOutputDropped: false,
    })
    const result = watched.result as { bufferStartsAt: string, watchedAt: string, openedAt: string }
    expect(Date.parse(result.bufferStartsAt)).toBeGreaterThanOrEqual(Date.parse(result.openedAt))
    expect(Date.parse(result.watchedAt)).toBeGreaterThanOrEqual(Date.parse(result.bufferStartsAt))

    print("FAIL src/webhooks/replay.spec.ts\r\n")
    await waitForDaemon(() => expect(outputs(phone)).toEqual(["FAIL src/webhooks/replay.spec.ts\r\n"]))
    expect(outputs(owner)).toEqual(["$ pnpm vitest run src/webhooks\r\n", "FAIL src/webhooks/replay.spec.ts\r\n"])

    // The phone reads; it cannot type, resize, claim or close.
    const scope = /A phone or tablet credential may only watch sessions/
    for (const [method, params] of [
      ["terminal.input", { terminalId: "terminal-1", data: "rm -rf /\n" }],
      ["terminal.resize", { terminalId: "terminal-1", cols: 52, rows: 40 }],
      ["terminal.claim", { terminalId: "terminal-1" }],
      ["terminal.close", { terminalId: "terminal-1" }],
    ] as const) {
      const reply = await phone.call(method, { ...params, client: "phone", clientId: "phone-full" })
      expect((reply.error as { message: string }).message, method).toMatch(scope)
    }
    expect(process.write).not.toHaveBeenCalled()
    expect(process.resize).not.toHaveBeenCalled()

    // A second desktop taking the claim is announced to the watcher.
    const other = await connect(daemon())
    expect(await other.call("system.hello", hello("desktop", "desktop-other", daemons[0]!.authToken))).not.toHaveProperty("error")
    expect(await other.call("terminal.claim", { terminalId: "terminal-1", client: "desktop", clientId: "desktop-other" })).not.toHaveProperty("error")
    await waitForDaemon(() => expect(phone.notifications).toContainEqual({
      method: "terminal.ownership",
      params: { terminalId: "terminal-1", owner: { client: "desktop", clientId: "desktop-other" } },
    }))

    expect(await phone.call("terminal.unwatch", { terminalId: "terminal-1" })).toMatchObject({ result: { accepted: true } })
    print("after unwatch\r\n")
    await waitForDaemon(() => expect(outputs(owner)).toContain("after unwatch\r\n"))
    expect(outputs(phone)).toEqual(["FAIL src/webhooks/replay.spec.ts\r\n"])

    expect(await phone.call("terminal.watch", { terminalId: "terminal-missing" })).toMatchObject({ error: { message: "Terminal does not exist" } })
  })

  it("sends the close, with its exit code, to a watcher and nothing to a bystander, and keeps the closed record for a while", async () => {
    const { session, print, exit, owner, pair } = await start({ terminalClosedRetentionMs: 200 })
    const tablet = await pair("tablet", "watching")
    const bystander = await connect(daemons[0]!)
    expect(await bystander.call("system.hello", hello("web", "web-bystander", daemons[0]!.authToken))).not.toHaveProperty("error")

    const create = { terminalId: "terminal-2", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "desktop-owner" }
    expect(await owner.call("terminal.create", create)).not.toHaveProperty("error")
    // A watching-only credential reads: watching is observation.
    expect(await tablet.call("terminal.watch", { terminalId: "terminal-2" })).toMatchObject({ result: { buffer: "" } })
    print("$ exit\r\n")
    exit({ exitCode: 0 })
    await waitForDaemon(() => expect(tablet.notifications).toContainEqual({
      method: "terminal.closed",
      params: { terminalId: "terminal-2", exitCode: 0 },
    }))
    expect(outputs(tablet)).toEqual(["$ exit\r\n"])
    // Closed is a state, not an error: the record stays readable with how the
    // shell ended, for the retention window, then is dropped.
    const closed = {
      terminalId: "terminal-2", sessionId: session.id, state: "closed", claimHeld: false, exitCode: 0, closedAt: expect.any(String),
      owner: { client: "desktop", clientId: "desktop-owner" },
    }
    expect(await tablet.call("terminal.list", { sessionId: session.id })).toMatchObject({ result: { terminals: [closed] } })
    expect(await tablet.call("terminal.watch", { terminalId: "terminal-2" })).toMatchObject({ result: { ...closed, buffer: "$ exit\r\n" } })
    expect(await tablet.call("terminal.unwatch", { terminalId: "terminal-2" })).toMatchObject({ result: { accepted: true } })
    await waitForDaemon(async () => {
      expect(await tablet.call("terminal.list", { sessionId: session.id })).toMatchObject({ result: { terminals: [] } })
    })
    expect(await tablet.call("terminal.watch", { terminalId: "terminal-2" })).toMatchObject({ error: { message: "Terminal does not exist" } })

    await bystander.call("workspace.get", {})
    expect(terminalMethods(bystander)).toEqual([])
  })

  it("keeps a watcher's disconnect from closing the terminal, and drops it from the audience", async () => {
    const { session, print, owner, pair, process } = await start()
    const phone = await pair("phone", "full")
    const create = { terminalId: "terminal-3", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "desktop-owner" }
    expect(await owner.call("terminal.create", create)).not.toHaveProperty("error")
    expect(await phone.call("terminal.watch", { terminalId: "terminal-3" })).not.toHaveProperty("error")
    phone.close()
    await waitForDaemon(async () => {
      const listed = await owner.call("terminal.list", { sessionId: session.id })
      expect(listed.result).toMatchObject({ terminals: [{ terminalId: "terminal-3", claimHeld: true }] })
    })
    print("still here\r\n")
    await waitForDaemon(() => expect(outputs(owner)).toEqual(["still here\r\n"]))
    expect(process.kill).not.toHaveBeenCalled()
  })
  it("names the claimant's paired device beside what it said of itself", async () => {
    const { session, owner, pair } = await start()
    const phone = await pair("phone", "full")
    const laptop = await pair("desktop", "full")
    const create = { terminalId: "terminal-4", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "desktop-owner" }
    expect(await owner.call("terminal.create", create)).not.toHaveProperty("error")
    expect(await phone.call("terminal.watch", { terminalId: "terminal-4" })).toMatchObject({
      result: { owner: { client: "desktop", clientId: "desktop-owner" } },
    })
    const claimed = await laptop.call("terminal.claim", { terminalId: "terminal-4", client: "desktop", clientId: "desktop-laptop" })
    const device = { id: expect.stringMatching(/^device-[0-9a-f]{32}$/), label: "desktop full" }
    expect(claimed).toMatchObject({ result: { owner: { client: "desktop", clientId: "desktop-laptop", device } } })
    await waitForDaemon(() => expect(phone.notifications.at(-1)).toMatchObject({
      method: "terminal.ownership",
      params: { terminalId: "terminal-4", owner: { client: "desktop", clientId: "desktop-laptop", device } },
    }))
    expect(await phone.call("terminal.list", { sessionId: session.id })).toMatchObject({
      result: { terminals: [{ terminalId: "terminal-4", owner: { device }, claimHeld: true }] },
    })
  })
})

describe("the boundary between a watch's record and its live output", () => {
  it("hands each printed line to a new watcher once, in the record or live, never both", async () => {
    const { session, print, owner, pair } = await start()
    const create = { terminalId: "terminal-boundary", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "desktop-owner" }
    expect(await owner.call("terminal.create", create)).not.toHaveProperty("error")
    for (let round = 0; round < 5; round += 1) {
      const phone = await pair("phone", "full")
      // Printed and still waiting in the output batch when the watch arrives.
      print(`line-${round}\r\n`)
      const watched = await phone.call("terminal.watch", { terminalId: "terminal-boundary" })
      print(`after-${round}\r\n`)
      await waitForDaemon(() => expect(outputs(phone).join("")).toContain(`after-${round}`))
      const seen = `${(watched.result as { buffer: string }).buffer}${outputs(phone).join("")}`
      expect(seen.split(`line-${round}\r\n`).length - 1, `round ${round}`).toBe(1)
      expect(seen.split(`after-${round}\r\n`).length - 1, `round ${round}`).toBe(1)
    }
  })
})

describe("closed records within one budget", () => {
  it("evicts the oldest closed records first until the new one fits", async () => {
    const { session, print, exit, owner, pair } = await start({ terminalClosedRetentionCharacters: 20 })
    const phone = await pair("phone", "full")
    for (const [index, text] of ["aaaaaaa\r\n", "bbbbbbb\r\n", "ccccccc\r\n"].entries()) {
      const create = { terminalId: `terminal-${index}`, sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "desktop-owner" }
      expect(await owner.call("terminal.create", create)).not.toHaveProperty("error")
      print(text)
      await waitForDaemon(() => expect(outputs(owner).join("")).toContain(text))
      exit({ exitCode: 0 })
      await waitForDaemon(() => expect(terminalMethods(owner).filter((method) => method === "terminal.closed")).toHaveLength(index + 1))
    }
    // Three records of 9 characters against 20: the oldest went first.
    const listed = await phone.call("terminal.list", { sessionId: session.id })
    expect((listed.result as { terminals: { terminalId: string }[] }).terminals.map(({ terminalId }) => terminalId).sort()).toEqual(["terminal-1", "terminal-2"])
    expect(await phone.call("terminal.watch", { terminalId: "terminal-0" })).toMatchObject({ error: { message: "Terminal does not exist" } })
    expect(await phone.call("terminal.watch", { terminalId: "terminal-2" })).toMatchObject({ result: { buffer: "ccccccc\r\n", state: "closed" } })
  })
})

describe("redaction across an idle flush", () => {
  it("never shows a value typed after its name was released on an idle beat, live, in a watch, or after close", async () => {
    const { session, print, exit, owner, pair } = await start()
    const phone = await pair("phone", "full")
    const create = { terminalId: "terminal-idle", sessionId: session.id, cols: 80, rows: 24, client: "desktop", clientId: "desktop-owner" }
    expect(await owner.call("terminal.create", create)).not.toHaveProperty("error")
    expect(await phone.call("terminal.watch", { terminalId: "terminal-idle" })).not.toHaveProperty("error")
    // A prompt with no newline is released on the idle beat; the value arrives after it.
    for (const [name, value] of [["export API_KEY=", "hunter2-live-value"], ["Password: ", "correct-horse-staple"]] as const) {
      print(name)
      await waitForDaemon(() => expect(outputs(owner).join("")).toContain(name))
      await new Promise((resolve) => setTimeout(resolve, 60))
      print(`${value}\r\n`)
      await waitForDaemon(() => expect(outputs(owner).join("")).toContain("\r\n"))
      await new Promise((resolve) => setTimeout(resolve, 60))
      print("$ \r\n")
    }
    await waitForDaemon(() => expect(outputs(phone).join("")).toContain("$ "))
    const watched = await phone.call("terminal.watch", { terminalId: "terminal-idle" })
    exit({ exitCode: 0 })
    await waitForDaemon(() => expect(terminalMethods(phone)).toContain("terminal.closed"))
    const closed = await phone.call("terminal.watch", { terminalId: "terminal-idle" })
    for (const text of [outputs(owner).join(""), outputs(phone).join(""), (watched.result as { buffer: string }).buffer, (closed.result as { buffer: string }).buffer]) {
      expect(text).not.toContain("hunter2-live-value")
      expect(text).not.toContain("correct-horse-staple")
      expect(text).toContain("export API_KEY=")
      expect(text).toContain("[REDACTED]")
    }
  })
})

function daemon(): DomovoiDaemon {
  return daemons[0]!
}
