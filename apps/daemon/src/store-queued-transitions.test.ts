import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { SqliteWorkspaceStore, type StoredQueuedSessionSend } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []
const stores: SqliteWorkspaceStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await removeScratchDirectories(scratchDirectories)
})

function queued(sessionId: string, id: string): StoredQueuedSessionSend {
  return {
    id,
    sessionId,
    state: "waiting",
    createdAt: "2026-09-03T18:00:00.000Z",
    origin: { client: "desktop", connectionId: "5f0c7c52-8f55-4b8e-9a51-0c1f6f0e2d11" },
    skillIds: [],
    attachments: [],
    prompt: "Run the checks next",
  }
}

async function storeWithTwoQueuedSends() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-queued-transitions-"))
  scratchDirectories.push(scratch)
  const databasePath = join(scratch, "state.sqlite")
  const store = new SqliteWorkspaceStore(databasePath, demoWorkspace)
  stores.push(store)
  const [first, second] = demoWorkspace.sessions
  store.replaceQueuedSessionSend(queued(first!.id, "queued-first"))
  store.replaceQueuedSessionSend(queued(second!.id, "queued-second"))
  return { store, databasePath, first: first!.id, second: second!.id }
}

const hold = (sessionId: string, queueId: string) => ({
  sessionId,
  queueId,
  from: ["waiting", "releasing"] as StoredQueuedSessionSend["state"][],
  to: "held" as const,
  reason: "The provider disconnected before the queued send could release.",
})

describe("queued send transitions in one transaction", () => {
  it("applies every transition and reports each result", async () => {
    const { store, first, second } = await storeWithTwoQueuedSends()

    expect(store.transitionQueuedSessionSends([
      hold(first, "queued-first"),
      hold(second, "queued-other"),
    ])).toEqual([true, false])

    expect(store.loadQueuedSessionSends().map(({ sessionId, state }) => [sessionId, state]))
      .toEqual([[first, "held"], [second, "waiting"]])
  })

  it("rolls every transition back when one of them throws", async () => {
    const { store, databasePath, first, second } = await storeWithTwoQueuedSends()
    const database = new DatabaseSync(databasePath)
    database.prepare("UPDATE queued_session_sends SET payload = ? WHERE session_id = ?").run("{", second)
    database.close()

    expect(() => store.transitionQueuedSessionSends([
      hold(first, "queued-first"),
      hold(second, "queued-second"),
    ])).toThrow(SyntaxError)

    const check = new DatabaseSync(databasePath)
    const states = check.prepare("SELECT session_id, state FROM queued_session_sends ORDER BY session_id").all()
    check.close()
    expect(states).toEqual([
      { session_id: first, state: "waiting" },
      { session_id: second, state: "waiting" },
    ].sort((left, right) => left.session_id.localeCompare(right.session_id)))
  })
})
