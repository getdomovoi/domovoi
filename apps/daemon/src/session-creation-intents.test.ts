import { DatabaseSync } from "node:sqlite"
import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { maximumPendingSessionCreations, SqliteSessionCreationIntents, type SessionCreationIntent } from "./session-creation-intents.js"

const databases: DatabaseSync[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })

function fixture() {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  return { database, journal: new SqliteSessionCreationIntents(database) }
}

function input(id = "session-creation", projectId = "project-creation") {
  const session: SessionCreationIntent["session"] = {
    id, projectId, title: "Interrupted setup", state: "failed",
    runtime: structuredClone(demoWorkspace.sessions[0]!.runtime),
    changedFiles: 0, testsPassed: 0, testsFailed: 0, updatedAt: "2026-09-12T12:00:00.000Z",
  }
  return { session, repositoryPath: "/repository", expectedWorkspacePath: `/worktrees/${id}` }
}

const workspace = { path: "/worktrees/session-creation", branch: "domovoi/session-creation", baseCommit: "a".repeat(40) }

describe("session creation intent journal", () => {
  it("keeps the intent distinct from its completion receipt", () => {
    const { journal } = fixture()
    const creation = input()
    journal.begin(creation)
    creation.session.title = "Changed after recording"
    expect(journal.pending("project-creation")).toEqual([{
      ...input(), version: 1, ownerPid: process.pid, cleanupStarted: false,
    }])
    journal.complete(creation.session.id, workspace)
    expect(journal.pending("project-creation")[0]?.workspace).toEqual(workspace)
  })

  it("names an already pending request without replacing its evidence", () => {
    const { journal } = fixture()
    journal.begin(input())
    const pending = journal.pending("project-creation")
    expect(() => journal.begin({ ...input(), repositoryPath: "/another-repository" })).toThrow("Session creation is already pending")
    expect(journal.pending("project-creation")).toEqual(pending)
  })

  it("allows the same request again only after cleanup discards its intent", () => {
    const { journal } = fixture()
    journal.begin(input())
    journal.complete("session-creation", workspace)
    expect(() => journal.discardAfterCleanup("session-creation")).toThrow("cleanup was not recorded")
    journal.beginCleanup("session-creation")
    journal.discardAfterCleanup("session-creation")
    expect(journal.pending("project-creation")).toEqual([])
    expect(() => journal.begin(input())).not.toThrow()
    expect(journal.pending("project-creation")[0]?.workspace).toBeUndefined()
  })

  it("refuses another process's completion or cleanup", () => {
    const { journal, database } = fixture()
    journal.begin(input())
    database.prepare("UPDATE session_creation_intents SET record = json_set(record, '$.ownerPid', ?)").run(process.pid + 1)
    const pending = journal.pending("project-creation")
    expect(() => journal.complete("session-creation", workspace)).toThrow("another process")
    expect(() => journal.beginCleanup("session-creation")).toThrow("another process")
    expect(() => journal.discardAfterCleanup("session-creation")).toThrow("another process")
    expect(journal.pending("project-creation")).toEqual(pending)
  })

  it("keeps recovery evidence when cleanup deletion fails", () => {
    const { journal, database } = fixture()
    journal.begin(input())
    journal.beginCleanup("session-creation")
    database.exec("CREATE TRIGGER refuse_creation_delete BEFORE DELETE ON session_creation_intents BEGIN SELECT RAISE(FAIL, 'injected deletion failure'); END")
    expect(() => journal.discardAfterCleanup("session-creation")).toThrow("injected deletion failure")
    expect(journal.pending("project-creation")).toHaveLength(1)
  })

  it("keeps a receipt for inspection after cleanup starts and refuses a late completion", () => {
    const { journal } = fixture()
    expect(() => journal.beginCleanup("session-creation")).toThrow("intent disappeared")
    journal.begin(input())
    journal.complete("session-creation", workspace)
    journal.beginCleanup("session-creation")
    expect(journal.pending("project-creation")[0]).toMatchObject({ workspace, cleanupStarted: true })
    expect(() => journal.beginCleanup("session-creation")).toThrow("cleanup already started")
    expect(() => journal.complete("session-creation", workspace)).toThrow("cleanup already started")
  })

  it("preserves the prior receipt when recording cleanup fails", () => {
    const { journal, database } = fixture()
    journal.begin(input())
    journal.complete("session-creation", workspace)
    database.exec("CREATE TRIGGER refuse_cleanup_start BEFORE UPDATE ON session_creation_intents BEGIN SELECT RAISE(FAIL, 'injected cleanup recording failure'); END")
    expect(() => journal.beginCleanup("session-creation")).toThrow("injected cleanup recording failure")
    expect(journal.pending("project-creation")[0]).toMatchObject({ workspace, cleanupStarted: false })
  })

  it("keeps an incomplete intent when receipt publication fails", () => {
    const { journal, database } = fixture()
    journal.begin(input())
    database.exec("CREATE TRIGGER refuse_creation_update BEFORE UPDATE ON session_creation_intents BEGIN SELECT RAISE(FAIL, 'injected receipt failure'); END")
    expect(() => journal.complete("session-creation", workspace)).toThrow("injected receipt failure")
    expect(journal.pending("project-creation")[0]?.workspace).toBeUndefined()
  })

  it("clears only canonical sessions and keeps other projects' pending work", () => {
    const { journal } = fixture()
    journal.begin(input())
    journal.begin(input("session-other", "project-other"))
    journal.clearCommitted([input().session])
    expect(journal.pending("project-creation")).toEqual([])
    expect(journal.pending("project-other")).toHaveLength(1)
  })

  it.each([
    { state: "idle" }, { workspacePath: "/usable-workspace" }, { providerThreadId: "usable-thread" }, { activeTurnId: "active-turn" },
  ])("refuses a draft that already publishes usable state: %j", (patch) => {
    const { journal } = fixture()
    const creation = input()
    expect(() => journal.begin({ ...creation, session: { ...creation.session, ...patch } as SessionCreationIntent["session"] }))
      .toThrow("Creation intent must not publish a usable session")
    expect(journal.pending("project-creation")).toEqual([])
  })

  it("bounds UTF-8 bytes, including individually valid multibyte paths", () => {
    const { journal } = fixture()
    expect(() => journal.begin({ ...input(), repositoryPath: "你".repeat(23_000) })).toThrow("byte budget")
    expect(journal.pending("project-creation")).toEqual([])
  })

  it("bounds pending creations across projects before accepting another", () => {
    const { journal } = fixture()
    for (let i = 0; i < maximumPendingSessionCreations; i++) journal.begin(input(`session-${i}`))
    expect(() => journal.begin(input("session-over-budget", "project-other"))).toThrow("budget is full")
    expect(journal.pending("project-creation")).toHaveLength(maximumPendingSessionCreations)
    expect(journal.pending("project-other")).toEqual([])
  })

  it("refuses stored identity drift before using a receipt", () => {
    const { journal, database } = fixture()
    journal.begin(input())
    database.exec("UPDATE session_creation_intents SET project_id = 'project-other'")
    expect(() => journal.pending("project-other")).toThrow("conflicting identity")
  })
})
