import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createEmptyWorkspace, demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SqliteWorkspaceStore } from "./store.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("SqliteWorkspaceStore", () => {
  it("keeps audit receipts across workspace-store reopen", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const first = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    first.auditLog.append({
      id: "audit-persisted",
      occurredAt: "2026-08-29T12:00:00.000Z",
      actor: { kind: "client", client: "desktop" },
      action: "session.send",
      outcome: "succeeded",
      sessionId: demoWorkspace.sessions[0]!.id,
    })
    first.close()

    const reopened = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    expect(reopened.auditLog.query({ limit: 10 }).entries).toEqual([
      expect.objectContaining({ id: "audit-persisted", action: "session.send" }),
    ])
    reopened.close()
  })

  it("restores daemon-owned workspace state after reopening", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const first = new SqliteWorkspaceStore(databasePath, demoWorkspace, {
      manageDirectoryPermissions: true,
    })
    const changed = structuredClone(demoWorkspace)
    changed.machine.name = "workstation"
    changed.sessions[0]!.runtime.model = "gpt-5.6-sol"
    changed.approvalRules.push({
      id: "rule-1",
      projectId: changed.project!.id,
      operation: "Run tests",
      command: "pnpm test",
      createdBy: "desktop",
      createdAt: "2026-08-26T06:00:00.000Z",
    })

    first.save(changed)
    first.close()

    const reopened = new SqliteWorkspaceStore(
      databasePath,
      createEmptyWorkspace(demoWorkspace.machine),
      { legacySnapshots: [demoWorkspace] },
    )
    expect(reopened.load()).toEqual(changed)
    reopened.close()
  })

  it("replaces only the untouched legacy demo seed", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const legacySnapshot = structuredClone(demoWorkspace)
    legacySnapshot.annotations = []
    const legacy = new SqliteWorkspaceStore(databasePath, legacySnapshot)
    legacy.close()

    const empty = createEmptyWorkspace({
      ...demoWorkspace.machine,
      name: "workstation",
      platform: "linux",
      arch: "x64",
    })
    const upgraded = new SqliteWorkspaceStore(databasePath, empty, {
      legacySnapshots: [demoWorkspace],
    })

    expect(upgraded.load()).toEqual(empty)
    upgraded.close()
  })

  it("repairs a legacy project machine reference once without clearing project state", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const seed = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    seed.close()
    const legacy = structuredClone(demoWorkspace)
    legacy.machine.id = "machine-current"
    legacy.project!.machineId = "machine-retired"
    legacy.sessions[0]!.title = "Preserve this session"
    const database = new DatabaseSync(databasePath)
    database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(JSON.stringify(legacy))
    database.close()

    const first = new SqliteWorkspaceStore(databasePath, createEmptyWorkspace(legacy.machine))
    const repaired = first.load()
    expect(repaired.project).toEqual({ ...legacy.project, machineId: "machine-current" })
    expect(repaired.sessions).toEqual(legacy.sessions)
    expect(repaired.approvals).toEqual(legacy.approvals)
    expect(repaired.approvalRules).toEqual(legacy.approvalRules)
    expect(repaired.artifacts).toEqual(legacy.artifacts)
    expect(repaired.annotations).toEqual(legacy.annotations)
    expect(repaired.thread.slice(0, legacy.thread.length)).toEqual(legacy.thread)
    expect(repaired.thread.filter((item) =>
      item.kind === "system" && item.body === "Stored project machine reference repaired"
    )).toEqual([
      expect.objectContaining({ sessionId: legacy.activeSessionId }),
    ])
    first.close()

    const second = new SqliteWorkspaceStore(databasePath, createEmptyWorkspace(legacy.machine))
    expect(second.load().thread.filter((item) =>
      item.kind === "system" && item.body === "Stored project machine reference repaired"
    )).toHaveLength(1)
    second.close()
  })

  it("ties a machine-reference repair receipt to the first session without an active session", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const seed = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    seed.close()
    const legacy = structuredClone(demoWorkspace)
    legacy.machine.id = "machine-current"
    legacy.project!.machineId = "machine-retired"
    legacy.activeSessionId = null
    const database = new DatabaseSync(databasePath)
    database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(JSON.stringify(legacy))
    database.close()

    const reopened = new SqliteWorkspaceStore(databasePath, createEmptyWorkspace(legacy.machine))
    expect(reopened.load().thread).toContainEqual(expect.objectContaining({
      kind: "system",
      body: "Stored project machine reference repaired",
      sessionId: legacy.sessions[0]!.id,
    }))
    reopened.close()
  })

  it("returns a repaired live snapshot when migration persistence is busy", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const store = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    const legacy = structuredClone(demoWorkspace)
    legacy.machine.id = "machine-current"
    legacy.project!.machineId = "machine-retired"
    const database = new DatabaseSync(databasePath)
    database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(JSON.stringify(legacy))
    database.close()
    const persist = vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked")
    })

    expect(store.load()).toMatchObject({
      machine: { id: "machine-current" },
      project: { machineId: "machine-current" },
    })
    expect(persist).toHaveBeenCalledOnce()
    persist.mockRestore()
    store.close()
  })

  it("still rejects malformed live state before migration persistence", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const store = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    const database = new DatabaseSync(databasePath)
    database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run("{}")
    database.close()

    expect(() => store.load()).toThrow()
    store.close()
  })

  it.skipIf(process.platform === "win32")("repairs private state and sidecar permissions", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const stateDirectory = join(scratch, "state")
    const databasePath = join(stateDirectory, "state.sqlite")
    await mkdir(stateDirectory, { mode: 0o777 })

    const first = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    first.close()
    await chmod(stateDirectory, 0o777)
    await chmod(databasePath, 0o666)

    const reopened = new SqliteWorkspaceStore(databasePath, demoWorkspace, {
      manageDirectoryPermissions: true,
    })
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600)

    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`]
    for (const sidecar of sidecars) {
      await chmod(sidecar, 0o666)
    }
    reopened.save(demoWorkspace)
    for (const sidecar of sidecars) {
      expect((await stat(sidecar)).mode & 0o777).toBe(0o600)
    }
    reopened.close()
  })

  it.skipIf(process.platform === "win32")("does not chmod a caller-owned custom directory", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    await chmod(scratch, 0o777)

    const store = new SqliteWorkspaceStore(join(scratch, "state.sqlite"), demoWorkspace)

    expect((await stat(scratch)).mode & 0o777).toBe(0o777)
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    store.close()
  })
})
