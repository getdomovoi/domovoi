import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SqliteWorkspaceStore, type StoredQueuedSessionSend } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
    prompt: "p".repeat(100_000),
  }
}

// A full database makes SQLite end the transaction itself. A page limit on the
// store's own connection, set just before the named statement, produces that.
function fillBefore(fragment: string) {
  const prepare = DatabaseSync.prototype.prepare
  const limited: DatabaseSync[] = []
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.includes(fragment) && limited.length === 0) {
      limited.push(this)
      const pages = prepare.call(this, "PRAGMA page_count").get() as { page_count: number }
      this.exec(`PRAGMA max_page_count = ${pages.page_count}`)
    }
    return prepare.call(this, sql)
  })
  return {
    limited,
    release: () => { for (const database of limited) database.exec("PRAGMA max_page_count = 1073741823") },
  }
}

describe("store transactions SQLite ends itself", () => {
  it("reports the original error when a queued-send batch fills the database", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-rollback-"))
    scratchDirectories.push(scratch)
    const store = new SqliteWorkspaceStore(join(scratch, "state.sqlite"), demoWorkspace)
    try {
      store.replaceQueuedSessionSend(queued("session-billing", "queue-one"))
      const full = fillBefore("UPDATE queued_session_sends")
      try {
        expect(() => store.transitionQueuedSessionSends([
          { sessionId: "session-billing", queueId: "queue-one", from: ["waiting"], to: "held", reason: "r".repeat(1_000) },
        ])).toThrow("database or disk is full")
        expect(full.limited).toHaveLength(1)
      } finally { full.release() }
    } finally { await store.close() }
  })

  it("reports the original error when a transferred snapshot fills the database", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-rollback-"))
    scratchDirectories.push(scratch)
    const imported = structuredClone(demoWorkspace)
    const targetMachineId = `machine-${"b".repeat(32)}`
    const sourceMachineId = `machine-${"a".repeat(32)}`
    const transferId = `transfer-${"c".repeat(32)}`
    const manifestDigest = `sha256:${"d".repeat(64)}`
    const checkpointCommit = "e".repeat(40)
    imported.machine.id = targetMachineId
    imported.project = { ...imported.project!, id: "project-target", machineId: targetMachineId, path: "/target/project" }
    const session = imported.sessions[0]!
    session.projectId = imported.project.id
    session.workspacePath = "/target/session"
    session.baseCommit = checkpointCommit
    session.ownershipGeneration = 2
    session.transferredFrom = {
      transferId, sourceMachineId, generation: 2, manifestDigest, checkpointCommit, completedAt: "2026-09-03T22:00:00.000Z",
    }
    imported.sessions = [session]
    imported.activeSessionId = session.id
    imported.thread = imported.thread.filter((item) => item.sessionId === session.id)
    imported.artifacts = imported.artifacts.filter((artifact) => artifact.sessionId === session.id)
    imported.workingPlans = imported.workingPlans.filter((plan) => plan.sessionId === session.id)
    imported.annotations = imported.annotations.filter((annotation) => annotation.sessionId === session.id)
    imported.approvals = imported.approvals.filter((approval) => approval.sessionId === session.id)
    const store = new SqliteWorkspaceStore(join(scratch, "state.sqlite"), imported)
    const grown = structuredClone(imported)
    for (let index = 0; index < 40; index += 1) {
      grown.thread.push({ id: `system-grown-${index}`, sessionId: session.id, kind: "system", body: "b".repeat(2_000), createdAt: "2026-09-03T22:00:00.000Z" })
    }
    try {
      const full = fillBefore("INSERT INTO workspace_state")
      try {
        expect(() => store.saveTransferredSnapshot(grown, {
          version: 2, transferId, manifestDigest, sessionId: session.id, sourceMachineId, targetMachineId,
          targetProjectId: "project-target", workspacePath: "/target/session", checkpointCommit, generation: 2,
          completedAt: "2026-09-03T22:00:00.000Z",
        })).toThrow("database or disk is full")
        expect(full.limited).toHaveLength(1)
      } finally { full.release() }
    } finally { await store.close() }
  })
})
