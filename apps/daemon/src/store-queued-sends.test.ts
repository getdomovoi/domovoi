import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore, type StoredQueuedSessionSend } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []
const daemons: DomovoiDaemon[] = []

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories)
})

function queued(sessionId: string, id: string): StoredQueuedSessionSend {
  return {
    id,
    sessionId,
    state: "waiting",
    createdAt: "2026-09-22T12:00:00.000Z",
    origin: { client: "desktop", connectionId: "11111111-1111-4111-8111-111111111111" },
    skillIds: [],
    attachments: [],
    prompt: `queued for ${sessionId}`,
  }
}

async function seeded() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-queued-sends-"))
  scratchDirectories.push(scratch)
  const path = join(scratch, "state.sqlite")
  const store = new SqliteWorkspaceStore(path, demoWorkspace)
  store.replaceQueuedSessionSend(queued("session-billing", "queue-readable"))
  store.replaceQueuedSessionSend(queued("session-audit", "queue-damaged"))
  await store.close()
  return path
}

function damage(path: string, statement: string, ...values: string[]) {
  const database = new DatabaseSync(path)
  try {
    database.prepare(statement).run(...values)
  } finally { database.close() }
}

describe("queued sends that cannot be read", () => {
  it.each([
    ["a truncated payload", "UPDATE queued_session_sends SET payload = substr(payload, 1, 20) WHERE queue_id = ?"],
    ["a state this build does not know", "UPDATE queued_session_sends SET state = 'scheduled' WHERE queue_id = ?"],
  ])("moves %s aside and loads the rest", async (_name, statement) => {
    const path = await seeded()
    damage(path, statement, "queue-damaged")
    const store = new SqliteWorkspaceStore(path, demoWorkspace)
    try {
      const unreadable = vi.fn()
      expect(store.loadQueuedSessionSends(unreadable).map((send) => send.id)).toEqual(["queue-readable"])
      expect(unreadable).toHaveBeenCalledOnce()
      expect(unreadable).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-audit",
        queueId: "queue-damaged",
        reason: expect.any(String),
      }))
      expect(store.auditLog.query({ action: "queued-send.quarantine" }).entries).toEqual([
        expect.objectContaining({ outcome: "succeeded", target: "queue-damaged" }),
      ])
      expect(store.loadQueuedSessionSends().map((send) => send.id)).toEqual(["queue-readable"])
    } finally { await store.close() }
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("SELECT queue_id FROM queued_session_send_quarantine").all())
        .toEqual([{ queue_id: "queue-damaged" }])
    } finally { database.close() }
  })

  it("starts the daemon over a damaged queued send", async () => {
    const path = await seeded()
    damage(path, "UPDATE queued_session_sends SET payload = 'null' WHERE queue_id = ?", "queue-damaged")
    const errorSink = vi.fn()
    const daemon = new DomovoiDaemon({ port: 0, statePath: path, errorSink, agents: {} })
    daemons.push(daemon)
    await daemon.start()
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
      context: "Domovoi moved an unreadable queued message aside",
    }))
  })

  it("bounds a transition reason so the row can be read again", async () => {
    const path = await seeded()
    const store = new SqliteWorkspaceStore(path, demoWorkspace)
    try {
      expect(store.transitionQueuedSessionSend(
        "session-audit",
        "queue-damaged",
        ["waiting"],
        "held",
        `  ${"r".repeat(1_100)}  `,
      )).toBe(true)
      expect(store.transitionQueuedSessionSend("session-billing", "queue-readable", ["waiting"], "held", "   ")).toBe(true)
      const unreadable = vi.fn()
      const loaded = store.loadQueuedSessionSends(unreadable)
      expect(unreadable).not.toHaveBeenCalled()
      expect(loaded.find((send) => send.id === "queue-damaged")?.reason).toHaveLength(1_024)
      expect(loaded.find((send) => send.id === "queue-readable")?.reason).toBeUndefined()
    } finally { await store.close() }
  })
})
