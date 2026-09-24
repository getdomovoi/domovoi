import { once } from "node:events"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

// Desktop V2 palette, "Sessions on other machines": each machine searches its
// own sessions by title and summary and answers for itself. The summary is
// the newest assistant message the daemon holds for the session.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

let nextId = 1
async function connect(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(3_000) })
  return (method: string, params: Record<string, unknown>) => {
    const id = nextId++
    return new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
}

async function start() {
  const snapshot = structuredClone(demoWorkspace)
  const daemon = new DomovoiDaemon({ port: 0, store: new SqliteWorkspaceStore(":memory:", snapshot) })
  daemons.push(daemon)
  await daemon.start()
  const call = await connect(daemon)
  expect(await call("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).not.toHaveProperty("error")
  return { daemon, snapshot, call }
}

type Match = { session: { id: string }, matchedIn: string }
const ids = (reply: Record<string, unknown>) => (reply.result as { matches: Match[] }).matches.map((match) => [match.session.id, match.matchedIn])

describe("session.search", () => {
  it("matches titles first, then the newest assistant message, case-insensitively", async () => {
    const { snapshot, call } = await start()
    const billing = snapshot.sessions[0]!
    expect(billing.title).toContain("webhooks")
    const inTitle = await call("session.search", { query: "WEBHOOKS" })
    expect(inTitle.result).toMatchObject({ query: "WEBHOOKS", truncated: false })
    expect(ids(inTitle)).toEqual([[billing.id, "title"]])
    expect((inTitle.result as { matches: Match[] }).matches[0]!.session).toMatchObject({ id: billing.id, title: billing.title, state: billing.state })

    // "replay.spec.ts" is in the billing session's newest assistant message only.
    const inSummary = await call("session.search", { query: "replay.spec.ts" })
    expect(ids(inSummary)).toEqual([[billing.id, "summary"]])

    expect(ids(await call("session.search", { query: "nothing says this" }))).toEqual([])
  })

  it("cuts the list at the limit and says so", async () => {
    const { snapshot, call } = await start()
    // Every demo title carries an "e"; the limit keeps one and the answer says more matched.
    expect(snapshot.sessions.filter((session) => /e/i.test(session.title)).length).toBeGreaterThan(1)
    const cut = await call("session.search", { query: "e", limit: 1 })
    expect(cut.result).toMatchObject({ truncated: true })
    expect(ids(cut)).toHaveLength(1)
    const whole = await call("session.search", { query: "e" })
    expect(whole.result).toMatchObject({ truncated: false })
    expect(ids(whole).length).toBe(snapshot.sessions.filter((session) => /e/i.test(session.title)).length)
  })

  it("refuses an empty query and stays off the phone list", async () => {
    const { daemon, call } = await start()
    expect(await call("session.search", { query: "   " })).toHaveProperty("error")

    const minted = await call("device.pair", { label: "iPhone", client: "desktop", targetClient: "phone" })
    const phone = await connect(daemon)
    const token = (minted.result as { token: string }).token
    expect(await phone("system.hello", { client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: token })).not.toHaveProperty("error")
    const refused = await phone("session.search", { query: "webhooks" })
    expect((refused.error as { message: string }).message).toMatch(/A phone or tablet credential may only/)
  })
})
