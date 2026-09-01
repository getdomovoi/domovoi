import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"

import { workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { SqliteAuditLog, type AuditLog } from "./audit-log.js"
import { SqliteDeviceRegistry, type DeviceRegistry } from "./device-registry.js"
import { SqliteFleetRegistry, type FleetRegistry } from "./fleet-registry.js"
import { redactWorkspaceCopies } from "./secret-redaction.js"

type StoredWorkspace = {
  snapshot: string
}

export interface WorkspaceStore {
  readonly auditLog?: AuditLog
  readonly devices?: DeviceRegistry
  readonly fleet?: FleetRegistry
  load(): WorkspaceSnapshot
  save(snapshot: WorkspaceSnapshot): void
  saveAsync?(snapshot: WorkspaceSnapshot): Promise<void>
  close(): void | Promise<void>
}

export type WorkspaceStoreOptions = {
  legacySnapshots?: WorkspaceSnapshot[]
  manageDirectoryPermissions?: boolean
}

function legacyFingerprint(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify({ ...snapshot, annotations: [] })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function migrateStoredWorkspace(value: unknown): {
  snapshot: WorkspaceSnapshot
  repaired: boolean
} {
  if (!isRecord(value) || !isRecord(value.machine) || !isRecord(value.project)) {
    return finalizeStoredWorkspace(workspaceSnapshotSchema.parse(value), false)
  }
  const machineId = value.machine.id
  const storedMachineId = value.project.machineId
  if (
    typeof machineId !== "string"
    || machineId.length === 0
    || typeof storedMachineId !== "string"
    || storedMachineId === machineId
  ) return finalizeStoredWorkspace(workspaceSnapshotSchema.parse(value), false)

  const migrated = structuredClone(value)
  const project = migrated.project as Record<string, unknown>
  project.machineId = machineId
  const projectId = project.id
  const sessions = Array.isArray(migrated.sessions) ? migrated.sessions : []
  const validSessions = sessions.filter((session): session is Record<string, unknown> =>
    isRecord(session)
    && typeof session.id === "string"
    && session.id.length > 0
    && session.projectId === projectId
  )
  const activeSession = validSessions.find((session) => session.id === migrated.activeSessionId)
  const receiptSession = activeSession ?? validSessions[0]
  if (receiptSession && Array.isArray(migrated.thread)) {
    migrated.thread.push({
      id: `system-machine-reference-${randomUUID()}`,
      sessionId: receiptSession.id,
      kind: "system",
      body: "Stored project machine reference repaired",
      detail: `Updated project.machineId from ${storedMachineId} to ${machineId} while preserving project state.`,
      createdAt: new Date().toISOString(),
    })
  }
  return finalizeStoredWorkspace(workspaceSnapshotSchema.parse(migrated), true)
}

function finalizeStoredWorkspace(
  snapshot: WorkspaceSnapshot,
  repaired: boolean,
): { snapshot: WorkspaceSnapshot; repaired: boolean } {
  const sanitized = redactWorkspaceCopies(snapshot)
  return {
    snapshot: sanitized,
    repaired: repaired || JSON.stringify(sanitized) !== JSON.stringify(snapshot),
  }
}

type WriterResponse = {
  id: number
  error?: string
}

const workspaceWriterSource = String.raw`
const { existsSync, chmodSync } = require("node:fs")
const { DatabaseSync } = require("node:sqlite")
const { parentPort, workerData } = require("node:worker_threads")

async function start() {
  const { workspaceSnapshotSchema } = await import(workerData.protocolUrl)
  const database = new DatabaseSync(workerData.path)
  database.exec("PRAGMA journal_mode = WAL;")
  database.exec("PRAGMA busy_timeout = 5000;")
  const save = database.prepare(
    "INSERT INTO workspace_state (id, snapshot, updated_at) VALUES (1, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at",
  )
  parentPort.on("message", (message) => {
    try {
      if (message.close) {
        database.close()
        parentPort.postMessage({ id: message.id })
        return
      }
      const validated = workspaceSnapshotSchema.parse(message.snapshot)
      save.run(JSON.stringify(validated), message.updatedAt)
      if (process.platform !== "win32") {
        for (const path of [workerData.path, workerData.path + "-wal", workerData.path + "-shm"]) {
          if (existsSync(path)) chmodSync(path, 0o600)
        }
      }
      parentPort.postMessage({ id: message.id })
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

start().catch((error) => { throw error })
`

class AsyncWorkspaceWriter {
  readonly #worker: Worker
  readonly #pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  #nextId = 0
  #closing: Promise<void> | undefined
  // Once the worker is gone, nothing will ever answer a posted message, so the
  // reason it went is kept and every later request is refused with it.
  #terminal: Error | undefined

  constructor(path: string) {
    this.#worker = new Worker(workspaceWriterSource, {
      eval: true,
      workerData: { path, protocolUrl: import.meta.resolve("@getdomovoi/protocol") },
    })
    this.#worker.on("message", (response: WriterResponse) => {
      const pending = this.#pending.get(response.id)
      if (!pending) return
      this.#pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve()
    })
    this.#worker.on("error", (cause: unknown) => {
      const error = cause instanceof Error
        ? cause
        : new Error("Workspace persistence worker failed")
      this.#terminal = error
      this.#rejectPending(error)
    })
    this.#worker.on("exit", (code) => {
      this.#terminal ??= this.#closing
        ? new Error("Workspace persistence worker is closed")
        : new Error(`Workspace persistence worker exited with code ${code}`)
      if (code !== 0 && !this.#closing) this.#rejectPending(this.#terminal)
    })
  }

  write(snapshot: WorkspaceSnapshot): Promise<void> {
    return this.#request({ snapshot, updatedAt: new Date().toISOString() })
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closing = this.#request({ close: true }).then(async () => {
      await this.#worker.terminate()
      this.#terminal ??= new Error("Workspace persistence worker is closed")
    })
    return this.#closing
  }

  #request(message: Record<string, unknown>): Promise<void> {
    if (this.#terminal) return Promise.reject(this.#terminal)
    const id = ++this.#nextId
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#worker.postMessage({ id, ...message })
    })
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  readonly path: string
  readonly auditLog: SqliteAuditLog
  readonly devices: SqliteDeviceRegistry
  readonly fleet: SqliteFleetRegistry
  #database: DatabaseSync
  #writer: AsyncWorkspaceWriter | undefined

  constructor(path: string, initial: WorkspaceSnapshot, options: WorkspaceStoreOptions = {}) {
    this.path = path
    if (path !== ":memory:") prepareStatePath(path, options.manageDirectoryPermissions === true)
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workspace_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    this.auditLog = new SqliteAuditLog(this.#database)
    this.devices = new SqliteDeviceRegistry(this.#database)
    this.fleet = new SqliteFleetRegistry(this.#database)

    const existing = this.#database
      .prepare("SELECT snapshot FROM workspace_state WHERE id = 1")
      .get() as StoredWorkspace | undefined
    const migratedExisting = existing
      ? migrateStoredWorkspace(JSON.parse(existing.snapshot))
      : undefined
    const existingSnapshot = migratedExisting?.snapshot
    const isLegacySeed = existingSnapshot?.annotations.length === 0 &&
      options.legacySnapshots?.some(
        (snapshot) => legacyFingerprint(existingSnapshot) === legacyFingerprint(
          workspaceSnapshotSchema.parse(snapshot),
        ),
    )
    if (!existing) this.save(initial)
    else if (migratedExisting?.repaired) this.save(migratedExisting.snapshot)
    else if (isLegacySeed) this.save(initial)
    this.#restrictFilePermissions()
  }

  load(): WorkspaceSnapshot {
    const row = this.#database
      .prepare("SELECT snapshot FROM workspace_state WHERE id = 1")
      .get() as StoredWorkspace | undefined
    if (!row) throw new Error("Workspace state is not initialized")
    const migrated = migrateStoredWorkspace(JSON.parse(row.snapshot))
    if (migrated.repaired) {
      try {
        this.save(migrated.snapshot)
      } catch {
        return migrated.snapshot
      }
    }
    return migrated.snapshot
  }

  save(snapshot: WorkspaceSnapshot): void {
    const validated = workspaceSnapshotSchema.parse(redactWorkspaceCopies(snapshot))
    this.#writeValidated(validated)
  }

  async saveAsync(snapshot: WorkspaceSnapshot): Promise<void> {
    const sanitized = redactWorkspaceCopies(snapshot)
    if (this.path === ":memory:") {
      await new Promise<void>((resolve) => setImmediate(resolve))
      this.#writeValidated(workspaceSnapshotSchema.parse(sanitized))
      return
    }
    this.#writer ??= new AsyncWorkspaceWriter(this.path)
    await this.#writer.write(sanitized)
  }

  #writeValidated(snapshot: WorkspaceSnapshot): void {
    this.#database
      .prepare(`
        INSERT INTO workspace_state (id, snapshot, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          snapshot = excluded.snapshot,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(snapshot), new Date().toISOString())
    this.#restrictFilePermissions()
  }

  close(): void | Promise<void> {
    if (!this.#writer) {
      this.#database.close()
      return
    }
    return this.#writer.close().then(() => this.#database.close())
  }

  #restrictFilePermissions(): void {
    if (this.path === ":memory:" || process.platform === "win32") return
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  }
}

function prepareStatePath(path: string, manageDirectoryPermissions: boolean): void {
  const directory = dirname(path)
  const directoryExists = existsSync(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32" && (manageDirectoryPermissions || !directoryExists)) {
    chmodSync(directory, 0o700)
  }

  const handle = openSync(path, "a", 0o600)
  closeSync(handle)
  if (process.platform !== "win32") chmodSync(path, 0o600)
}
