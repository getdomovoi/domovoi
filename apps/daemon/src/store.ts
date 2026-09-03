import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"

import {
  protocolVersion,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { SqliteAuditLog, type AuditLog } from "./audit-log.js"
import { SqliteDeviceRegistry, type DeviceRegistry } from "./device-registry.js"
import { SqliteTransferReceipts, type TransferReceipts } from "./transfer-receipts.js"
import { SqliteFleetRegistry, type FleetRegistry } from "./fleet-registry.js"
import { SqliteSkillReviews, type SkillReviews } from "./skill-reviews.js"
import { redactWorkspaceCopies } from "./secret-redaction.js"

type StoredWorkspace = {
  snapshot: string
}

export type WorkspaceStoreRecovery = {
  kind: "database" | "snapshot"
  quarantinedPath: string
  reason: string
}

type StoredProjectWorkspace = {
  state: string
}

export type ProjectWorkspaceState = {
  project: NonNullable<WorkspaceSnapshot["project"]>
  sessions: WorkspaceSnapshot["sessions"]
  activeSessionId: WorkspaceSnapshot["activeSessionId"]
  approvals: WorkspaceSnapshot["approvals"]
  approvalRules: WorkspaceSnapshot["approvalRules"]
  thread: WorkspaceSnapshot["thread"]
  artifacts: WorkspaceSnapshot["artifacts"]
  annotations: WorkspaceSnapshot["annotations"]
}

export function projectWorkspaceState(
  snapshot: WorkspaceSnapshot,
): ProjectWorkspaceState | undefined {
  const project = snapshot.project
  if (!project) return undefined
  return {
    project,
    sessions: snapshot.sessions,
    activeSessionId: snapshot.activeSessionId,
    approvals: snapshot.approvals,
    approvalRules: snapshot.approvalRules,
    thread: snapshot.thread,
    artifacts: snapshot.artifacts,
    annotations: snapshot.annotations,
  }
}

export interface WorkspaceStore {
  readonly auditLog?: AuditLog
  readonly devices?: DeviceRegistry
  readonly fleet?: FleetRegistry
  readonly transferReceipts?: TransferReceipts
  readonly skillReviews?: SkillReviews
  readonly recovery?: WorkspaceStoreRecovery | undefined
  load(): WorkspaceSnapshot
  loadProject?(projectId: string): ProjectWorkspaceState | undefined
  save(snapshot: WorkspaceSnapshot): void
  saveAsync?(snapshot: WorkspaceSnapshot): Promise<void>
  close(): void | Promise<void>
}

export type WorkspaceWriter = {
  readonly failed: boolean
  write(snapshot: WorkspaceSnapshot): Promise<void>
  close(): Promise<void>
}

export type WorkspaceStoreOptions = {
  legacySnapshots?: WorkspaceSnapshot[]
  manageDirectoryPermissions?: boolean
  writerFactory?: (path: string) => WorkspaceWriter
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

// Only a database that is actually unreadable is quarantined. A busy file, a
// permission error, or a full disk is an operational failure: renaming the file
// would move a healthy database out from under whoever holds it and start the
// daemon on an empty workspace, which loses more than it saves.
const corruptionCodes = new Set([
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_FORMAT",
  "ERR_SQLITE_ERROR",
])

export function isCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (typeof code === "string" && corruptionCodes.has(code) && /malformed|not a database|corrupt/i.test(message)) {
    return true
  }
  return /file is not a database|database disk image is malformed|database is corrupt/i.test(message)
}

function openWorkspaceDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS workspace_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_projects (
        project_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  } catch (error) {
    database.close()
    throw error
  }
  return database
}

function quarantineStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function quarantineDatabase(path: string): string {
  const quarantined = `${path}.corrupt-${quarantineStamp()}`
  renameSync(path, quarantined)
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${quarantined}${suffix}`)
  }
  return quarantined
}

function quarantineSnapshot(path: string, snapshot: string): string {
  const quarantined = `${path}.snapshot-corrupt-${quarantineStamp()}.json`
  writeFileSync(quarantined, snapshot, { mode: 0o600 })
  return quarantined
}

function describeFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.replace(/\s+/g, " ").trim().slice(0, 240)
}

function recoveredWorkspace(
  initial: WorkspaceSnapshot,
  recovery: WorkspaceStoreRecovery,
): WorkspaceSnapshot {
  const sessionId = initial.activeSessionId ?? initial.sessions[0]?.id
  if (initial.project === null || sessionId === undefined) return initial
  const subject = recovery.kind === "database" ? "state database" : "workspace snapshot"
  return {
    ...initial,
    thread: [...initial.thread, {
      id: `system-state-recovery-${randomUUID()}`,
      sessionId,
      kind: "system",
      body: `Stored ${subject} could not be read and was moved aside`,
      detail: `Domovoi started from its initial workspace. The unreadable ${subject} was kept at ${recovery.quarantinedPath}. ${recovery.reason}`,
      createdAt: new Date().toISOString(),
    }],
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
  database.exec("PRAGMA synchronous = NORMAL;")
  const save = database.prepare(
    "INSERT INTO workspace_state (id, snapshot, updated_at) VALUES (1, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at",
  )
  const saveProject = database.prepare(
    "INSERT INTO workspace_projects (project_id, state, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
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
      if (validated.project) {
        saveProject.run(
          validated.project.id,
          JSON.stringify({
            project: validated.project,
            sessions: validated.sessions,
            activeSessionId: validated.activeSessionId,
            approvals: validated.approvals,
            approvalRules: validated.approvalRules,
            thread: validated.thread,
            artifacts: validated.artifacts,
            annotations: validated.annotations,
          }),
          message.updatedAt,
        )
      }
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

  get failed(): boolean {
    return this.#terminal !== undefined
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
  readonly transferReceipts: SqliteTransferReceipts
  readonly skillReviews: SqliteSkillReviews
  readonly recovery: WorkspaceStoreRecovery | undefined
  #database: DatabaseSync
  #writer: WorkspaceWriter | undefined
  #writerFactory: WorkspaceStoreOptions["writerFactory"]
  #writerClosed = false
  #databaseClosed = false

  constructor(path: string, initial: WorkspaceSnapshot, options: WorkspaceStoreOptions = {}) {
    this.path = path
    const manageDirectoryPermissions = options.manageDirectoryPermissions === true
    if (path !== ":memory:") prepareStatePath(path, manageDirectoryPermissions)
    let recovery: WorkspaceStoreRecovery | undefined
    let database: DatabaseSync
    try {
      database = openWorkspaceDatabase(path)
    } catch (error) {
      if (path === ":memory:") throw error
      // An operational failure is reported to the caller rather than repaired,
      // so a locked or unreadable file is never renamed aside.
      if (!isCorruption(error)) throw error
      recovery = {
        kind: "database",
        quarantinedPath: quarantineDatabase(path),
        reason: describeFailure(error),
      }
      prepareStatePath(path, manageDirectoryPermissions)
      database = openWorkspaceDatabase(path)
    }
    this.#database = database
    this.#writerFactory = options.writerFactory
    this.auditLog = new SqliteAuditLog(this.#database)
    this.devices = new SqliteDeviceRegistry(this.#database)
    this.fleet = new SqliteFleetRegistry(this.#database)
    this.transferReceipts = new SqliteTransferReceipts(this.#database)
    this.skillReviews = new SqliteSkillReviews(this.#database)

    const existing = this.#database
      .prepare("SELECT snapshot FROM workspace_state WHERE id = 1")
      .get() as StoredWorkspace | undefined
    let migratedExisting: ReturnType<typeof migrateStoredWorkspace> | undefined
    if (existing) {
      try {
        migratedExisting = migrateStoredWorkspace(JSON.parse(existing.snapshot))
      } catch (error) {
        recovery = {
          kind: "snapshot",
          quarantinedPath: quarantineSnapshot(path, existing.snapshot),
          reason: describeFailure(error),
        }
      }
    }
    const existingSnapshot = migratedExisting?.snapshot
    const isLegacySeed = existingSnapshot?.annotations.length === 0 &&
      options.legacySnapshots?.some(
        (snapshot) => legacyFingerprint(existingSnapshot) === legacyFingerprint(
          workspaceSnapshotSchema.parse(snapshot),
        ),
    )
    this.recovery = recovery
    if (recovery) this.save(recoveredWorkspace(initial, recovery))
    else if (!existing) this.save(initial)
    else if (migratedExisting?.repaired) this.save(migratedExisting.snapshot)
    else if (isLegacySeed) this.save(initial)
    else if (existingSnapshot) this.#seedProjectRow(existingSnapshot)
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
    if (this.#writer?.failed && !this.#writerClosed) this.#writer = undefined
    this.#writer ??= this.#writerFactory?.(this.path) ?? new AsyncWorkspaceWriter(this.path)
    await this.#writer.write(sanitized)
  }

  loadProject(projectId: string): ProjectWorkspaceState | undefined {
    const row = this.#database
      .prepare("SELECT state FROM workspace_projects WHERE project_id = ?")
      .get(projectId) as StoredProjectWorkspace | undefined
    if (!row) return undefined
    const stored = JSON.parse(row.state) as Record<string, unknown>
    const candidate = {
      ...stored,
      protocolVersion,
      machine: this.load().machine,
      skillEnablements: [],
    } as unknown as WorkspaceSnapshot
    return projectWorkspaceState(
      workspaceSnapshotSchema.parse(redactWorkspaceCopies(candidate)),
    )
  }

  #seedProjectRow(snapshot: WorkspaceSnapshot): void {
    const state = projectWorkspaceState(snapshot)
    if (!state) return
    this.#database
      .prepare(`
        INSERT INTO workspace_projects (project_id, state, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO NOTHING
      `)
      .run(state.project.id, JSON.stringify(state), new Date().toISOString())
  }

  #writeValidated(snapshot: WorkspaceSnapshot): void {
    const updatedAt = new Date().toISOString()
    this.#database
      .prepare(`
        INSERT INTO workspace_state (id, snapshot, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          snapshot = excluded.snapshot,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(snapshot), updatedAt)
    const state = projectWorkspaceState(snapshot)
    if (state) {
      this.#database
        .prepare(`
          INSERT INTO workspace_projects (project_id, state, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET
            state = excluded.state,
            updated_at = excluded.updated_at
        `)
        .run(state.project.id, JSON.stringify(state), updatedAt)
    }
    this.#restrictFilePermissions()
  }

  close(): void | Promise<void> {
    if (!this.#writer) {
      this.#closeDatabase()
      return
    }
    this.#writerClosed = true
    // The worker can fail to shut down, and the main connection still has to be
    // released, so the failure is reported after the handle is closed.
    return this.#writer.close().finally(() => this.#closeDatabase())
  }

  #closeDatabase(): void {
    if (this.#databaseClosed) return
    this.#databaseClosed = true
    this.#database.close()
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
