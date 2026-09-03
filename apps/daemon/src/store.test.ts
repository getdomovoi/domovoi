import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { removeScratchDirectories } from "./test-scratch.js"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createEmptyWorkspace, demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { isCorruption, SqliteWorkspaceStore, type WorkspaceWriter } from "./store.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

describe("SqliteWorkspaceStore", () => {
  it("keeps the event loop responsive while persisting long history", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-long-history-"))
    scratchDirectories.push(scratch)
    const store = new SqliteWorkspaceStore(join(scratch, "state.sqlite"), demoWorkspace)
    const snapshot = structuredClone(demoWorkspace)
    snapshot.thread = Array.from({ length: 6_000 }, (_, index) => ({
      id: `long-history-${index}`,
      sessionId: snapshot.sessions[0]!.id,
      kind: "user" as const,
      body: `message-${index}-${"x".repeat(2_048)}`,
      createdAt: "2026-08-30T12:00:00.000Z",
    }))
    let heartbeats = 0
    const heartbeat = setInterval(() => { heartbeats += 1 }, 1)
    const startedAt = performance.now()

    await store.saveAsync(snapshot)

    const elapsedMs = performance.now() - startedAt
    clearInterval(heartbeat)
    expect(store.load().thread).toHaveLength(6_000)
    expect(heartbeats).toBeGreaterThanOrEqual(2)
    expect(elapsedMs).toBeLessThan(5_000)
    await store.close()
  }, 10_000)

  it("redacts every durable command copy and drops legacy secret-bearing rules", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-redaction-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const store = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    const changed = structuredClone(demoWorkspace)
    changed.approvals[0]!.risk = "normal"
    changed.approvals[0]!.command = "pnpm test --token persisted-command-secret"
    changed.approvals[0]!.operation = "Authorization: Bearer persisted-reason-secret"
    changed.approvalRules.push({
      id: "rule-secret",
      projectId: changed.project!.id,
      operation: "Deploy with secret",
      command: "deploy --api-key persisted-rule-secret",
      createdBy: "desktop",
      createdAt: "2026-08-29T12:00:00.000Z",
    })
    changed.thread.push({
      id: "tool-secret",
      sessionId: changed.sessions[0]!.id,
      kind: "tool",
      tool: "command",
      status: "completed",
      title: "pnpm test --password persisted-title-secret",
      output: "token=persisted-output-secret",
      createdAt: "2026-08-29T12:00:00.000Z",
    })

    store.save(changed)
    const loaded = store.load()
    expect(loaded.approvals[0]).toMatchObject({
      risk: "hard-gate",
      command: "pnpm test --token [REDACTED]",
      operation: "Authorization: [REDACTED]",
    })
    expect(loaded.approvalRules).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rule-secret" }),
    ]))
    expect(loaded.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "tool-secret",
        title: "pnpm test --password [REDACTED]",
        output: "token=[REDACTED]",
      }),
    ]))
    const database = new DatabaseSync(databasePath)
    const raw = database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get()
    database.close()
    expect(JSON.stringify(raw)).not.toMatch(
      /persisted-command-secret|persisted-reason-secret|persisted-rule-secret|persisted-title-secret|persisted-output-secret/,
    )
    store.close()
  })

  it("repairs a pre-existing raw snapshot before returning it after restart", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-legacy-redaction-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const seed = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    seed.close()
    const legacy = structuredClone(demoWorkspace)
    legacy.thread.push({
      id: "legacy-tool-secret",
      sessionId: legacy.sessions[0]!.id,
      kind: "tool",
      tool: "command",
      status: "completed",
      title: "pnpm test --token legacy-command-secret",
      output: "password=legacy-output-secret",
      createdAt: "2026-08-29T12:00:00.000Z",
    })
    const injected = new DatabaseSync(databasePath)
    injected.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1")
      .run(JSON.stringify(legacy))
    injected.close()

    const reopened = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    const visible = reopened.load()
    expect(visible.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "legacy-tool-secret",
        title: "pnpm test --token [REDACTED]",
        output: "password=[REDACTED]",
      }),
    ]))
    reopened.close()
    const repaired = new DatabaseSync(databasePath)
    const raw = repaired.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get()
    repaired.close()
    expect(JSON.stringify(raw)).not.toMatch(/legacy-command-secret|legacy-output-secret/)
  })

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

  it("keeps paired device credentials across workspace-store reopen", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const first = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    const paired = first.devices.pair({ label: "studio-ipad" })
    first.close()

    const reopened = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    expect(reopened.devices.verify(paired.token)?.id).toBe(paired.device.id)
    expect(reopened.devices.list()).toEqual([
      expect.objectContaining({ id: paired.device.id, label: "studio-ipad" }),
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
    changed.sessions[0]!.providerFailure = {
      kind: "authentication-expired",
      action: "sign-in",
      message: "Provider authentication expired",
      retryable: false,
    }
    changed.approvalRules.push({
      id: "rule-1",
      projectId: changed.project!.id,
      operation: "Run tests",
      command: "pnpm test",
      createdBy: "desktop",
      createdByConnectionId: "11111111-1111-4111-8111-111111111111",
      createdByClientId: "desktop-one",
      createdAt: "2026-08-26T06:00:00.000Z",
    })
    changed.approvalRules.push({
      id: "legacy-rule-client-id",
      projectId: changed.project!.id,
      operation: "Run legacy tests",
      command: "pnpm test:legacy",
      createdBy: "desktop",
      createdByClientId: "legacy-desktop-one",
      createdAt: "2026-08-26T06:00:00.000Z",
    })
    changed.thread.push({
      id: "receipt-client-identity",
      sessionId: changed.sessions[0]!.id,
      kind: "receipt",
      decision: "allow-once",
      operation: "Run tests",
      checkpoint: "checkpoint-one",
      client: "desktop",
      connectionId: "11111111-1111-4111-8111-111111111111",
      clientId: "desktop-one",
      createdAt: "2026-08-30T12:00:00.000Z",
    })
    changed.thread.push({
      id: "legacy-receipt-client-id",
      sessionId: changed.sessions[0]!.id,
      kind: "receipt",
      decision: "allow-once",
      operation: "Run legacy tests",
      checkpoint: "checkpoint-one",
      client: "desktop",
      clientId: "legacy-desktop-one",
      createdAt: "2026-08-30T12:00:00.000Z",
    })
    changed.skillEnablements.push({
      projectId: changed.project!.id,
      skillId: "skill-111111111111",
      enabled: true,
      contentDigest: `sha256:${"a".repeat(64)}`,
      manifest: { version: 1, capabilities: ["filesystem.read"] },
      reviewedAt: "2026-08-30T12:00:00.000Z",
      reviewedBy: { client: "desktop", clientId: "desktop-one" },
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

  describe("recovery from unreadable state", () => {
    const initial = demoWorkspace
    const auditEntry = {
      id: "audit-before-corruption",
      occurredAt: "2026-08-29T12:00:00.000Z",
      actor: { kind: "client", client: "desktop" },
      action: "session.send",
      outcome: "succeeded",
      sessionId: demoWorkspace.sessions[0]!.id,
    } as const

    async function seedThenDamage(
      name: string,
      damage: (databasePath: string) => Promise<string>,
    ): Promise<{ scratch: string; databasePath: string; damaged: string }> {
      const scratch = await mkdtemp(join(tmpdir(), `domovoi-store-${name}-`))
      scratchDirectories.push(scratch)
      const databasePath = join(scratch, "state.sqlite")
      const seed = new SqliteWorkspaceStore(databasePath, demoWorkspace)
      seed.auditLog.append(auditEntry)
      seed.close()
      const damaged = await damage(databasePath)
      return { scratch, databasePath, damaged }
    }

    function replaceSnapshotRow(databasePath: string, snapshot: string): string {
      const database = new DatabaseSync(databasePath)
      database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(snapshot)
      const row = database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get() as { snapshot: string }
      database.close()
      return row.snapshot
    }

    function recoveryNotice(quarantinedPath: string) {
      return expect.objectContaining({
        id: expect.stringMatching(/^system-state-recovery-/),
        sessionId: initial.activeSessionId,
        kind: "system",
        detail: expect.stringContaining(quarantinedPath),
      })
    }

    function recovered(quarantinedPath: string) {
      return { ...initial, thread: [...initial.thread, recoveryNotice(quarantinedPath)] }
    }

    async function expectPersistedRecovery(
      scratch: string,
      databasePath: string,
      quarantinedPath: string,
    ): Promise<void> {
      const entriesBefore = (await readdir(scratch)).sort()
      const reopened = new SqliteWorkspaceStore(databasePath, initial)
      expect(reopened.recovery).toBeUndefined()
      expect(reopened.load()).toEqual(recovered(quarantinedPath))
      reopened.close()
      expect((await readdir(scratch)).sort()).toEqual(entriesBefore)
    }

    it.each([
      ["unable to open database file", "ERR_SQLITE_ERROR"],
      ["database is locked", "SQLITE_BUSY"],
      ["attempt to write a readonly database", "SQLITE_READONLY"],
      ["disk I/O error", "SQLITE_IOERR"],
      ["EACCES: permission denied, open", "EACCES"],
    ])("treats %j as operational rather than corruption", (message, code) => {
      // Quarantine renames the live database, so anything that is merely
      // unavailable must propagate instead: a locked or unreadable file is
      // still a healthy one, and moving it loses more than it saves.
      expect(isCorruption(Object.assign(new Error(message), { code }))).toBe(false)
    })

    it.each([
      ["file is not a database", "ERR_SQLITE_ERROR"],
      ["database disk image is malformed", "SQLITE_CORRUPT"],
    ])("treats %j as corruption", (message, code) => {
      expect(isCorruption(Object.assign(new Error(message), { code }))).toBe(true)
    })

    it("does not quarantine a locked live database", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-locked-"))
      scratchDirectories.push(scratch)
      const databasePath = join(scratch, "state.sqlite")
      const lock = new DatabaseSync(databasePath)
      lock.exec("CREATE TABLE held_open (id INTEGER); BEGIN EXCLUSIVE")
      const before = await stat(databasePath)
      try {
        expect(() => new SqliteWorkspaceStore(databasePath, initial)).toThrow(/locked/i)
        expect((await readdir(scratch)).some((entry) => entry.includes(".corrupt-"))).toBe(false)
        expect((await stat(databasePath)).ino).toBe(before.ino)
      } finally {
        lock.exec("ROLLBACK")
        lock.close()
      }
    })

    it("keeps a truncated snapshot row beside the database and reseeds the workspace", async () => {
      const { scratch, databasePath, damaged } = await seedThenDamage("truncated-json", async (path) => {
        const database = new DatabaseSync(path)
        const row = database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get() as { snapshot: string }
        database.close()
        return replaceSnapshotRow(path, row.snapshot.slice(0, 40))
      })

      const store = new SqliteWorkspaceStore(databasePath, initial)
      const recovery = store.recovery
      expect(recovery).toEqual({
        kind: "snapshot",
        quarantinedPath: expect.stringMatching(/state\.sqlite\.snapshot-corrupt-[0-9TZ-]+\.json$/),
        reason: expect.stringContaining("JSON"),
      })
      expect(await readFile(recovery!.quarantinedPath, "utf8")).toBe(damaged)
      expect(await readdir(scratch)).toContain(join(recovery!.quarantinedPath).slice(scratch.length + 1))
      expect(store.load()).toEqual(recovered(recovery!.quarantinedPath))
      expect(store.auditLog.query({ limit: 10 }).entries).toEqual([
        expect.objectContaining({ id: "audit-before-corruption" }),
      ])
      store.close()

      await expectPersistedRecovery(scratch, databasePath, recovery!.quarantinedPath)
    })

    it("keeps a schema-incompatible snapshot row beside the database and reseeds the workspace", async () => {
      const incompatible = '{"protocolVersion":"999","machine":{"id":"m"}}'
      const { scratch, databasePath, damaged } = await seedThenDamage("schema-incompatible", async (path) =>
        replaceSnapshotRow(path, incompatible),
      )

      const store = new SqliteWorkspaceStore(databasePath, initial)
      const recovery = store.recovery
      expect(recovery).toEqual({
        kind: "snapshot",
        quarantinedPath: expect.stringMatching(/state\.sqlite\.snapshot-corrupt-[0-9TZ-]+\.json$/),
        reason: expect.stringContaining("ZodError"),
      })
      expect(damaged).toBe(incompatible)
      expect(await readFile(recovery!.quarantinedPath, "utf8")).toBe(incompatible)
      expect(store.load()).toEqual(recovered(recovery!.quarantinedPath))
      expect(store.auditLog.query({ limit: 10 }).entries).toEqual([
        expect.objectContaining({ id: "audit-before-corruption" }),
      ])
      store.close()

      await expectPersistedRecovery(scratch, databasePath, recovery!.quarantinedPath)
    })

    it("moves a file that is not a database aside without its stale WAL and starts fresh", async () => {
      const garbage = "this is not sqlite\n".repeat(64)
      const { scratch, databasePath } = await seedThenDamage("not-a-database", async (path) => {
        await writeFile(path, garbage)
        await writeFile(`${path}-wal`, "stale wal")
        return garbage
      })

      const store = new SqliteWorkspaceStore(databasePath, initial)
      const recovery = store.recovery
      expect(recovery).toEqual({
        kind: "database",
        quarantinedPath: expect.stringMatching(/state\.sqlite\.corrupt-[0-9TZ-]+$/),
        reason: expect.stringContaining("not a database"),
      })
      expect(await readFile(recovery!.quarantinedPath, "utf8")).toBe(garbage)
      const freshSidecar = await readFile(`${databasePath}-wal`, "utf8").catch(() => "")
      expect(freshSidecar).not.toBe("stale wal")
      expect((await stat(databasePath)).size).toBeGreaterThan(0)
      expect(store.load()).toEqual(recovered(recovery!.quarantinedPath))
      expect(store.auditLog.query({ limit: 10 }).entries).toEqual([])
      store.close()

      await expectPersistedRecovery(scratch, databasePath, recovery!.quarantinedPath)
    })

    it("starts an unopened workspace from the initial snapshot and reports the recovery", async () => {
      const empty = createEmptyWorkspace(demoWorkspace.machine)
      const { databasePath, damaged } = await seedThenDamage("unopened", async (path) =>
        replaceSnapshotRow(path, "{}"),
      )

      const store = new SqliteWorkspaceStore(databasePath, empty, { legacySnapshots: [demoWorkspace] })
      expect(store.recovery).toMatchObject({ kind: "snapshot" })
      expect(await readFile(store.recovery!.quarantinedPath, "utf8")).toBe(damaged)
      expect(store.load()).toEqual(empty)
      store.close()
    })
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

it("waits for a busy database instead of failing immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-busy-"))
  scratchDirectories.push(root)
  const path = join(root, "state.sqlite")
  const store = new SqliteWorkspaceStore(path, demoWorkspace)
  try {
    // Boot the writer first, so the contention below is with a live worker
    // rather than with worker startup.
    await store.saveAsync?.({ ...demoWorkspace })

    const held = new DatabaseSync(path)
    held.exec("PRAGMA busy_timeout = 0;")
    held.exec("BEGIN IMMEDIATE;")
    held.exec("INSERT INTO workspace_state (id, snapshot, updated_at) VALUES (1, '{}', 'now') " +
      "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at")
    const writing = store.saveAsync?.({ ...demoWorkspace })
    const released = new Promise<void>((resolve) => setTimeout(() => {
      held.exec("COMMIT;")
      held.close()
      resolve()
    }, 300))

    await expect(writing).resolves.toBeUndefined()
    await released
  } finally {
    await store.close()
  }
})

it("fails a write posted after the persistence worker is closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-dead-writer-"))
  scratchDirectories.push(root)
  const store = new SqliteWorkspaceStore(join(root, "state.sqlite"), demoWorkspace)
  await store.saveAsync?.({ ...demoWorkspace })
  await store.close()

  // Posting to a worker that has been terminated would otherwise never settle.
  await expect(store.saveAsync?.({ ...demoWorkspace })).rejects.toThrow(
    "Workspace persistence worker is closed",
  )
})

it("releases the database once the store is closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-close-"))
  scratchDirectories.push(root)
  const path = join(root, "state.sqlite")
  const store = new SqliteWorkspaceStore(path, demoWorkspace)
  await store.saveAsync?.({ ...demoWorkspace })
  await store.close()

  // Nothing may still hold the write lock, and a closing worker that failed
  // must not keep the handle either.
  const reopened = new DatabaseSync(path)
  reopened.exec("PRAGMA busy_timeout = 0;")
  reopened.exec("BEGIN IMMEDIATE; COMMIT;")
  reopened.close()
  await expect(store.saveAsync?.({ ...demoWorkspace })).rejects.toThrow(
    "Workspace persistence worker is closed",
  )
})

it("replaces a persistence worker that failed and accepts the next save", async () => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-writer-recreate-"))
  scratchDirectories.push(root)
  const written: WorkspaceSnapshot[] = []
  const closeWrites: unknown[] = []
  let failNext = true
  const factory = vi.fn((path: string): WorkspaceWriter => {
    const writer: { failed: boolean; closed: boolean } = { failed: false, closed: false }
    return {
      get failed() {
        return writer.failed
      },
      async write(snapshot: WorkspaceSnapshot) {
        if (writer.closed) throw new Error("Workspace persistence worker is closed")
        if (failNext) {
          failNext = false
          writer.failed = true
          throw new Error("Workspace persistence worker exited with code 1")
        }
        written.push(snapshot)
      },
      async close() {
        writer.closed = true
        closeWrites.push(path)
      },
    }
  })
  const store = new SqliteWorkspaceStore(join(root, "state.sqlite"), demoWorkspace, {
    writerFactory: factory,
  })

  await expect(store.saveAsync(demoWorkspace)).rejects.toThrow(
    "Workspace persistence worker exited with code 1",
  )
  await store.saveAsync(demoWorkspace)

  expect(factory).toHaveBeenCalledTimes(2)
  expect(written).toHaveLength(1)
  await store.close()
  await expect(store.saveAsync(demoWorkspace)).rejects.toThrow(
    "Workspace persistence worker is closed",
  )
  expect(factory).toHaveBeenCalledTimes(2)
})
