import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createEmptyWorkspace, demoWorkspace, sessionTransferContractVersion, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MultiProjectWorkspaceStateError, SqliteWorkspaceStore } from "./store.js"
import { redactWorkspaceCopies } from "./workspace-redaction.js"
import { removeScratchDirectories } from "./test-scratch.js"

const directories: string[] = []
afterEach(() => removeScratchDirectories(directories))
const restoreOptions = { restoreActiveProjects: true, manageDirectoryPermissions: false }
const fields = ["sessions", "approvals", "approvalRules", "thread", "artifacts", "workingPlans", "annotations"] as const

describe.each(["sync", "worker"] as const)("atomic project close (%s)", (mode) => {
  it.each([false, true])("saves the closed row with the active removal, injected failure: %s", async (fail) => {
    const path = await statePath()
    const store = new SqliteWorkspaceStore(path, several(), restoreOptions)
    try {
      const before = rows(path)
      const closed = projectCopy("a")
      closed.approvals = []
      for (const session of closed.sessions) {
        delete session.activeTurnId
        session.state = "idle"
      }
      const remaining = projectCopy("b")
      remaining.projects = [remaining.project!]
      if (fail) {
        const database = new DatabaseSync(path)
        database.exec(`CREATE TRIGGER reject_closed_project BEFORE INSERT ON workspace_projects
          WHEN NEW.project_id = '${closed.project!.id}' BEGIN SELECT RAISE(ABORT, 'injected close failure'); END`)
        database.close()
      }
      const save = () => mode === "sync"
        ? store.saveProjectClose(remaining, closed)
        : store.saveProjectCloseAsync(remaining, closed)
      if (fail) {
        await expect(Promise.resolve().then(save)).rejects.toThrow("injected close failure")
        expect(rows(path)).toEqual(before)
      } else {
        await save()
        expect(store.load().project?.id).toBe(remaining.project!.id)
        expect(store.load().sessions.every((session) => session.projectId === remaining.project!.id)).toBe(true)
        expect(store.loadProject(closed.project!.id)!.sessions).toEqual(closed.sessions)
        expect(store.loadProject(closed.project!.id)!.approvalRules).toEqual(closed.approvalRules)
      }
    } finally { await store.close() }
  })
})

function projectCopy(suffix: string): WorkspaceSnapshot {
  const original = structuredClone(demoWorkspace)
  const records = [original.project!, ...original.sessions, ...original.approvals, ...original.approvalRules,
    ...original.thread, ...original.artifacts, ...original.annotations]
  const ids = new Map(records.map(({ id }) => [id, `${id}-${suffix}`]))
  const copy = JSON.parse(JSON.stringify(original, (_key, value: unknown) => typeof value === "string" ? ids.get(value) ?? value : value)) as WorkspaceSnapshot
  copy.project!.path = `/synthetic/${suffix}`
  for (const session of copy.sessions) {
    if (session.runtime.provider === "opencode" || session.runtime.provider === "kilo") session.runtime.reasoning = "unset"
    session.workspacePath = `/synthetic/worktrees/${session.id}`
  }
  const at = "2026-11-06T12:00:00.000Z"
  copy.approvalRules = [{
    id: `rule-${suffix}`, projectId: copy.project!.id, operation: "Run tests", command: "pnpm test",
    createdBy: "desktop", createdAt: at, useCount: 0, status: "inactive",
    inactiveReason: "legacy-text-only", inactivatedAt: at,
  }]
  copy.workingPlans = [{ sessionId: copy.sessions[0]!.id, revision: 1, structureRevision: 0, steps: [], createdAt: at, updatedAt: at }]
  const artifact = copy.artifacts[0]!
  copy.annotations = [{
    id: `annotation-${suffix}`, sessionId: artifact.sessionId, artifactId: artifact.id,
    anchor: { textQuote: "Example" }, body: "Review this", status: "open", origin: "desktop",
    thread: [], createdAt: at, updatedAt: at,
  }]
  return workspaceSnapshotSchema.parse(copy)
}

function several(): WorkspaceSnapshot {
  const a = projectCopy("a")
  const b = projectCopy("b")
  return workspaceSnapshotSchema.parse({
    ...a, projects: [a.project, b.project], projectCap: 3,
    ...Object.fromEntries(fields.map((key) => [key, [...a[key], ...b[key]]])),
  })
}

// The exact project row main writes, independently of the new partitioner.
function legacyRow(snapshot: WorkspaceSnapshot) {
  return {
    project: snapshot.project, sessions: snapshot.sessions, activeSessionId: snapshot.activeSessionId,
    approvals: snapshot.approvals, approvalRules: snapshot.approvalRules, thread: snapshot.thread,
    artifacts: snapshot.artifacts, workingPlans: snapshot.workingPlans, annotations: snapshot.annotations,
  }
}

async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-active-projects-"))
  directories.push(directory)
  return join(directory, "state.sqlite")
}

function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      workspace: JSON.parse(String(db.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get()!.snapshot)) as WorkspaceSnapshot,
      projects: db.prepare("SELECT project_id, state FROM workspace_projects ORDER BY project_id").all()
        .map((row) => ({ id: row.project_id, state: JSON.parse(String(row.state)) as ReturnType<typeof legacyRow> })),
    }
  } finally { db.close() }
}

function bytes(path: string) {
  return [path, `${path}-wal`, `${path}-shm`].map((file) => existsSync(file) ? readFileSync(file) : undefined)
}

describe.each(["sync", "worker"] as const)("active project persistence (%s)", (mode) => {
  const save = async (store: SqliteWorkspaceStore, snapshot: WorkspaceSnapshot) => {
    if (mode === "sync") store.save(snapshot)
    else await store.saveAsync(snapshot)
  }

  it("keeps the one-project workspace and project rows identical to main", async () => {
    const path = await statePath()
    const snapshot = projectCopy("a")
    const store = new SqliteWorkspaceStore(path, snapshot)
    try {
      await save(store, snapshot)
      const persisted = rows(path)
      const expected = redactWorkspaceCopies(snapshot)
      expect(persisted.workspace).toEqual(expected)
      expect(persisted.workspace).not.toHaveProperty("projects")
      expect(persisted.projects).toEqual([{ id: snapshot.project!.id, state: legacyRow(expected) }])
    } finally { await store.close() }
  })

  it("writes isolated rows, a focused workspace, and restores all active state", async () => {
    const path = await statePath()
    const historical = projectCopy("closed")
    const snapshot = several()
    const store = new SqliteWorkspaceStore(path, historical, restoreOptions)
    try {
      await save(store, snapshot)
      const persisted = rows(path)
      expect(persisted.workspace.projects).toEqual(snapshot.projects)
      expect(persisted.workspace.sessions).toEqual(projectCopy("a").sessions)
      expect(persisted.projects).toHaveLength(3)
      for (const suffix of ["a", "b"]) {
        const own = redactWorkspaceCopies(projectCopy(suffix))
        const row = persisted.projects.find(({ id }) => id === own.project!.id)!.state
        expect(row).toEqual(legacyRow({ ...own, activeSessionId: suffix === "a" ? own.activeSessionId : null }))
        expect(row).not.toHaveProperty("projects")
      }
      expect(store.load()).toEqual(redactWorkspaceCopies(snapshot))
      expect(store.loadProject(snapshot.projects![1]!.id)?.sessions).toEqual(projectCopy("b").sessions)
    } finally { await store.close() }
    const reopened = new SqliteWorkspaceStore(path, createEmptyWorkspace(snapshot.machine), restoreOptions)
    try {
      expect(reopened.load()).toEqual(redactWorkspaceCopies(snapshot))
      expect(reopened.load()).toEqual(redactWorkspaceCopies(snapshot))
      expect(reopened.recovery).toBeUndefined()
    } finally { await reopened.close() }
    const before = bytes(path)
    expect(() => new SqliteWorkspaceStore(path, historical, { restoreActiveProjects: false })).toThrow(MultiProjectWorkspaceStateError)
    expect(bytes(path)).toEqual(before)
  })

  it("rolls back the workspace and all project rows when a later row write fails", async () => {
    const path = await statePath()
    const initial = projectCopy("a")
    const store = new SqliteWorkspaceStore(path, initial, restoreOptions)
    try {
      const db = new DatabaseSync(path)
      db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON workspace_projects WHEN NEW.project_id LIKE '%-b' BEGIN SELECT RAISE(ABORT, 'injected project write failure'); END")
      db.close()
      const before = rows(path)
      await expect(save(store, several())).rejects.toThrow("injected project write failure")
      expect(rows(path)).toEqual(before)
      expect(store.load()).toEqual(redactWorkspaceCopies(initial))
    } finally { await store.close() }
  })

  it("persists changed focus without losing either project's queued-send metadata", async () => {
    const path = await statePath()
    const snapshot = several()
    snapshot.project = snapshot.projects![1]!
    snapshot.activeSessionId = snapshot.sessions.find((session) => session.projectId === snapshot.project!.id)!.id
    snapshot.queuedSends = snapshot.projects!.map((project, index) => ({
      id: `queue-${index}`, sessionId: snapshot.sessions.find((session) => session.projectId === project.id)!.id,
      state: "waiting", createdAt: "2026-11-06T12:00:00.000Z",
      origin: { client: "desktop", connectionId: "00000000-0000-4000-8000-000000000000" }, skillIds: [], attachments: [],
    }))
    const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    try {
      await save(store, snapshot)
      expect(rows(path).workspace.queuedSends).toEqual([snapshot.queuedSends[1]])
      expect(store.load()).toEqual(redactWorkspaceCopies(snapshot))
    } finally { await store.close() }
    const reopened = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    try { expect(reopened.load()).toEqual(redactWorkspaceCopies(snapshot)) }
    finally { await reopened.close() }
  })

  it("refuses inconsistent focus rather than silently losing the active session", async () => {
    const path = await statePath()
    const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    try {
      const snapshot = several()
      snapshot.activeSessionId = snapshot.sessions.find((session) => session.projectId === snapshot.projects![1]!.id)!.id
      const before = rows(path)
      await expect(save(store, snapshot)).rejects.toThrow(/active session.*focused project/i)
      expect(rows(path)).toEqual(before)
    } finally { await store.close() }
  })

  it("retains over-cap projects and missing-folder markers across restart", async () => {
    const path = await statePath()
    const snapshot = several()
    snapshot.projectCap = 1
    snapshot.projects![1]!.unavailableReason = "folder-missing"
    const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    try { await save(store, snapshot) } finally { await store.close() }
    const reopened = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    try {
      const restored = reopened.load()
      expect(restored).toEqual(redactWorkspaceCopies(snapshot))
      expect(restored.projectCap).toBe(1)
      expect(restored.projects).toHaveLength(2)
      expect(restored.projects![1]!.unavailableReason).toBe("folder-missing")
    } finally { await reopened.close() }
  })

  it("writes only changed project rows while another project's thread streams", async () => {
    const path = await statePath()
    const snapshot = several()
    const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    const db = new DatabaseSync(path)
    try {
      await save(store, snapshot)
      db.exec("CREATE TABLE project_writes (id TEXT); CREATE TRIGGER observe_project_write AFTER UPDATE ON workspace_projects BEGIN INSERT INTO project_writes VALUES (NEW.project_id); END")
      await save(store, snapshot)
      expect(db.prepare("SELECT id FROM project_writes").all()).toEqual([])
      snapshot.thread.push({ id: "streamed-a", sessionId: snapshot.sessions[0]!.id, kind: "assistant", body: "More output", createdAt: "2026-11-06T12:00:00.000Z" })
      await save(store, snapshot)
      expect(db.prepare("SELECT id FROM project_writes").all()).toEqual([{ id: snapshot.project!.id }])
    } finally { db.close(); await store.close() }
  })
})

it.each([Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }), new Error("unexpected reader failure")])(
  "preserves non-validation errors during active-project restoration: %s", async (failure) => {
    const path = await statePath()
    const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    store.save(several())
    await store.close()
    const before = bytes(path)
    const original = DatabaseSync.prototype.prepare
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("SELECT state FROM workspace_projects")) throw failure
      return original.call(this, sql)
    })
    try {
      let caught: unknown
      try { new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions) } catch (error) { caught = error }
      expect(caught).toBe(failure)
      expect(bytes(path)).toEqual(before)
    } finally { spy.mockRestore() }
  },
)

it("does not quarantine a read failure after active-row preflight succeeded", async () => {
  const path = await statePath()
  const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
  store.save(several())
  await store.close()
  const before = rows(path)
  const failure = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
  const original = DatabaseSync.prototype.prepare
  let reads = 0
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.includes("SELECT state FROM workspace_projects") && ++reads === 3) throw failure
    return original.call(this, sql)
  })
  try {
    let caught: unknown
    try { new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions) } catch (error) { caught = error }
    expect(caught).toBe(failure)
    expect(rows(path)).toEqual(before)
    expect(readdirSync(directories.at(-1)!).some((name) => name.includes("corrupt"))).toBe(false)
  } finally { spy.mockRestore() }
})

it.each(["missing", "invalid-json", "mixed", "wrong-key", "wrong-project", "duplicate-session", "focused-mismatch"])(
  "refuses an unreadable active row (%s) without changing database or WAL bytes",
  async (damage) => {
    const path = await statePath()
    const snapshot = several()
    const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
    store.save(snapshot)
    await store.close()
    const keeper = new DatabaseSync(path)
    try {
      keeper.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
      const id = snapshot.projects![1]!.id
      const row = legacyRow(projectCopy(damage === "focused-mismatch" ? "a" : "b"))
      if (damage !== "focused-mismatch") row.activeSessionId = null
      if (damage === "missing") keeper.prepare("DELETE FROM workspace_projects WHERE project_id = ?").run(id)
      else {
        if (damage === "mixed") row.sessions.push(snapshot.sessions[0]!)
        if (damage === "wrong-key") row.project = snapshot.project
        if (damage === "wrong-project") row.project = { ...row.project!, path: "/synthetic/wrong" }
        if (damage === "duplicate-session") row.sessions[0]!.id = snapshot.sessions[0]!.id
        if (damage === "focused-mismatch") row.sessions[0]!.title = "inconsistent focused row"
        keeper.prepare("UPDATE workspace_projects SET state = ? WHERE project_id = ?").run(
          damage === "invalid-json" ? "{" : JSON.stringify(row), damage === "focused-mismatch" ? snapshot.project!.id : id,
        )
      }
      const before = bytes(path)
      const files = readdirSync(directories.at(-1)!)
      expect(() => new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)).toThrow(/active project.*unreadable/i)
      expect(bytes(path)).toEqual(before)
      expect(readdirSync(directories.at(-1)!)).toEqual(files)
    } finally { keeper.close() }
  },
)

it("restores durable ownership conflicts in every active project before returning state", async () => {
  const path = await statePath()
  const snapshot = several()
  const store = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
  const affected = snapshot.projects!.map((project) => snapshot.sessions.find((session) => session.projectId === project.id)!)
  for (const [index, session] of affected.entries()) {
    const transferId = `transfer-${String(index + 1).repeat(32)}`
    const target = `machine-${"e".repeat(32)}`
    session.ownershipGeneration = 1
    session.sourceRecovery = {
      transferId, targetMachineId: target, generation: 1, manifestDigest: `sha256:${"a".repeat(64)}`,
      recoveredAt: "2026-11-06T12:00:00.000Z", decidedBy: { client: "desktop", clientId: "test-desktop" },
    }
    store.transferConflicts.record({
      version: sessionTransferContractVersion, sessionId: session.id, sourceMachineId: snapshot.machine.id, sourceProjectId: session.projectId,
      workspacePath: session.workspacePath!, ownershipGeneration: 1, sourceRecovery: session.sourceRecovery,
      conflict: { kind: "recovery-contradicted", transferId, otherMachineId: target, otherGeneration: 2,
        detectedAt: "2026-11-06T12:01:00.000Z", recoveryAction: "keep-target-session" },
    })
  }
  store.save(snapshot)
  await store.close()
  const reopened = new SqliteWorkspaceStore(path, projectCopy("a"), restoreOptions)
  try {
    for (const loaded of [reopened.load(), reopened.load()]) {
      expect(affected.map(({ id }) => loaded.sessions.find((session) => session.id === id)!.state))
        .toEqual(["ownership-conflict", "ownership-conflict"])
    }
  } finally { await reopened.close() }
})
