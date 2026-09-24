import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

import {
  executionResolutionSchema,
  machineIdSchema,
  protocolCompatibility,
  protocolVersion,
  protocolVersionSchema,
  queuedSessionSendSchema,
  resolvedExecutionSchema,
  sessionSendParamsSchema,
  workspaceSnapshotSchema,
  type QueuedSessionSend,
  type SessionAttachment,
  type StateRecovery,
  type TurnSkillSelection,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { SqliteAuditLog, type AuditLog } from "./audit-log.js"
import { SqliteDeviceRegistry, storedDeviceRowIsValid, type DeviceRegistry } from "./device-registry.js"
import { SqliteTransferReceipts, type TransferReceipts } from "./transfer-receipts.js"
import { SqliteFleetRegistry, type FleetRegistry } from "./fleet-registry.js"
import { SqliteSkillReviews, type SkillReviews } from "./skill-reviews.js"
import {
  committedTransferOwnershipSchema,
  SqliteTransferOwnership,
  type CommittedTransferOwnership,
  type TransferOwnership,
} from "./transfer-ownership.js"
import {
  SqliteTransferConflicts,
} from "./transfer-conflicts.js"
import { redactWorkspaceCopies } from "./workspace-redaction.js"
import { SqliteSessionCreationIntents } from "./session-creation-intents.js"

type StoredWorkspace = {
  snapshot: string
}

export type WorkspaceStoreRecovery = StateRecovery & { quarantinedPath: string; reason: string }

type StoredProjectWorkspace = {
  state: string
}

type StoredQueuedSessionSendRow = {
  session_id: string
  queue_id: string
  state: string
  payload: string
}

export type StoredQueuedSessionSend = Omit<QueuedSessionSend, "state"> & {
  state: "waiting" | "held" | "refused" | "releasing" | "unconfirmed"
  prompt: string
  skillSelection?: TurnSkillSelection
  uploads?: SessionAttachment[]
  credentialDeviceId?: string
}

export type QueuedSessionSendTransition = {
  sessionId: string
  queueId: string
  from: StoredQueuedSessionSend["state"][]
  to: StoredQueuedSessionSend["state"]
  reason?: string
}

export type ProjectWorkspaceState = {
  project: NonNullable<WorkspaceSnapshot["project"]>
  sessions: WorkspaceSnapshot["sessions"]
  activeSessionId: WorkspaceSnapshot["activeSessionId"]
  approvals: WorkspaceSnapshot["approvals"]
  approvalRules: WorkspaceSnapshot["approvalRules"]
  thread: WorkspaceSnapshot["thread"]
  artifacts: WorkspaceSnapshot["artifacts"]
  workingPlans: WorkspaceSnapshot["workingPlans"]
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
    workingPlans: snapshot.workingPlans,
    annotations: snapshot.annotations,
  }
}

export interface WorkspaceStore {
  readonly auditLog?: AuditLog
  readonly devices?: DeviceRegistry
  readonly fleet?: FleetRegistry
  readonly transferReceipts?: TransferReceipts
  readonly transferOwnership?: TransferOwnership
  readonly transferConflicts?: SqliteTransferConflicts
  readonly skillReviews?: SkillReviews
  readonly sessionCreations?: SqliteSessionCreationIntents
  readonly recovery?: WorkspaceStoreRecovery | undefined
  load(): WorkspaceSnapshot
  loadProject?(projectId: string): ProjectWorkspaceState | undefined
  save(snapshot: WorkspaceSnapshot): void
  saveAsync?(snapshot: WorkspaceSnapshot): Promise<void>
  saveTransferredSnapshot?(
    snapshot: WorkspaceSnapshot,
    ownership: CommittedTransferOwnership,
  ): void | Promise<void>
  loadQueuedSessionSends?(): StoredQueuedSessionSend[]
  replaceQueuedSessionSend?(queued: StoredQueuedSessionSend): void
  transitionQueuedSessionSend?(
    sessionId: string,
    queueId: string,
    from: StoredQueuedSessionSend["state"][],
    to: StoredQueuedSessionSend["state"],
    reason?: string,
  ): boolean
  transitionQueuedSessionSends?(transitions: readonly QueuedSessionSendTransition[]): boolean[]
  deleteQueuedSessionSend?(sessionId: string, queueId: string): boolean
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
  integrityCheckMaximumBytes?: number
  writerFactory?: (path: string) => WorkspaceWriter
}

// Redacting a large snapshot costs tens of milliseconds of regex work, and the
// asynchronous write path exists so that cost does not land on the event loop
// while a provider streams. The persistence worker runs from an eval'd source
// and can only import real JavaScript, so the redaction is emitted as its own
// build entry and the worker is handed its URL. `dist` is the packaged layout;
// `../dist` is the layout when the daemon runs from `src`.
const workspaceRedactionCandidates = [
  "./workspace-redaction.js",
  "../dist/workspace-redaction.js",
]

export function resolveWorkspaceRedactionModule(): string | undefined {
  for (const specifier of workspaceRedactionCandidates) {
    let url: string
    try {
      url = import.meta.resolve(specifier)
    } catch {
      continue
    }
    // A loader that runs the daemon from TypeScript rewrites this to the
    // source file, which the worker cannot import, so only real JavaScript
    // counts as resolved.
    if (url.endsWith(".js") && existsSync(fileURLToPath(url))) return url
  }
  return undefined
}

const workspaceRedactionModule = resolveWorkspaceRedactionModule()

function legacyFingerprint(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify({ ...snapshot, annotations: [] })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A workspace written before canonical identity was enforced can hold a machine
// id the fleet and pairing contracts reject. Quarantining that database would
// throw away every stored session, so the legacy value is folded into the
// canonical shape instead. The derivation is deterministic, so the same legacy
// workspace keeps one identity across restarts.
function parseStoredQueuedSessionSend(row: StoredQueuedSessionSendRow): StoredQueuedSessionSend {
  if (!["waiting", "held", "refused", "releasing", "unconfirmed"].includes(row.state)) {
    throw new Error("Queued send state is invalid")
  }
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  const state = row.state as StoredQueuedSessionSend["state"]
  const metadata = queuedSessionSendSchema.parse({
    id: row.queue_id,
    sessionId: row.session_id,
    state: state === "releasing" ? "unconfirmed" : state,
    createdAt: payload.createdAt,
    origin: payload.origin,
    skillIds: payload.skillIds,
    attachments: payload.attachments,
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
  })
  const send = sessionSendParamsSchema.parse({
    sessionId: row.session_id,
    prompt: payload.prompt,
    client: metadata.origin.client,
    ...(payload.skillSelection === undefined ? {} : { skillSelection: payload.skillSelection }),
    ...(payload.uploads === undefined ? {} : { attachments: payload.uploads }),
    delivery: "next-turn-replace",
  })
  const credentialDeviceId = typeof payload.credentialDeviceId === "string"
    ? payload.credentialDeviceId
    : undefined
  return {
    ...metadata,
    state,
    prompt: send.prompt,
    ...(send.skillSelection ? { skillSelection: send.skillSelection } : {}),
    ...(send.attachments ? { uploads: send.attachments } : {}),
    ...(credentialDeviceId ? { credentialDeviceId } : {}),
  }
}

function canonicalizeLegacyMachineId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  if (machineIdSchema.safeParse(value).success) return undefined
  return `machine-${createHash("sha256").update(`legacy-machine:${value}`).digest("hex").slice(0, 32)}`
}

function appendSystemReceipt(
  migrated: Record<string, unknown>,
  body: string,
  detail: string,
): void {
  if (!Array.isArray(migrated.thread)) return
  const project = isRecord(migrated.project) ? migrated.project : undefined
  const projectId = project?.id
  const sessions = Array.isArray(migrated.sessions) ? migrated.sessions : []
  const validSessions = sessions.filter((session): session is Record<string, unknown> =>
    isRecord(session)
    && typeof session.id === "string"
    && session.id.length > 0
    && session.projectId === projectId
  )
  const activeSession = validSessions.find((session) => session.id === migrated.activeSessionId)
  const receiptSession = activeSession ?? validSessions[0]
  if (!receiptSession) return
  migrated.thread.push({
    id: `system-machine-reference-${randomUUID()}`,
    sessionId: receiptSession.id,
    kind: "system",
    body,
    detail,
    createdAt: new Date().toISOString(),
  })
}

function migrateStoredWorkspace(value: unknown): {
  snapshot: WorkspaceSnapshot
  repaired: boolean
  inactivatedRules: Array<{ id: string; projectId: string; inactivatedAt: string }>
} {
  if (!isRecord(value)) {
    return finalizeStoredWorkspace(workspaceSnapshotSchema.parse(value), false, [])
  }
  const migrated = structuredClone(value)
  let repaired = false
  // These reviewed predecessors retain their state. Rules from 0.6 gain a zero
  // use count below; full validation still runs before any migrated write.
  if (typeof migrated.protocolVersion === "string" && /^0\.(?:3|6|7)\.\d+$/.test(migrated.protocolVersion)) {
    migrated.protocolVersion = protocolVersion
    repaired = true
  }
  const inactivatedRules: Array<{ id: string; projectId: string; inactivatedAt: string }> = []
  if (Array.isArray(migrated.approvals)) {
    for (const approval of migrated.approvals) {
      if (!isRecord(approval) || executionResolutionSchema.safeParse(approval.execution).success) continue
      approval.execution = { state: "unresolved", reason: "unsupported-syntax" }
      repaired = true
    }
  }
  if (Array.isArray(migrated.approvalRules)) {
    for (const rule of migrated.approvalRules) {
      if (!isRecord(rule)) continue
      if (rule.useCount === undefined) {
        rule.useCount = 0
        repaired = true
      }
      const legacyTextOnly = rule.status === undefined
      const unsupportedRecord = rule.status === "active"
        && !resolvedExecutionSchema.safeParse(rule.execution).success
      if (!legacyTextOnly && !unsupportedRecord) continue
      const inactivatedAt = new Date().toISOString()
      rule.status = "inactive"
      rule.inactiveReason = legacyTextOnly ? "legacy-text-only" : "unsupported-record-version"
      rule.inactivatedAt = inactivatedAt
      delete rule.execution
      delete rule.replacedByRuleId
      repaired = true
      if (typeof rule.id === "string" && typeof rule.projectId === "string") {
        inactivatedRules.push({ id: rule.id, projectId: rule.projectId, inactivatedAt })
      }
    }
  }

  if (isRecord(migrated.machine)) {
    const canonical = canonicalizeLegacyMachineId(migrated.machine.id)
    if (canonical !== undefined) {
      const legacyMachineId = migrated.machine.id
      migrated.machine.id = canonical
      if (isRecord(migrated.project) && migrated.project.machineId === legacyMachineId) {
        migrated.project.machineId = canonical
      }
      appendSystemReceipt(
        migrated,
        "Stored machine identity migrated",
        `Replaced the legacy machine id ${String(legacyMachineId)} with ${canonical} so this workspace can be recorded in the fleet.`,
      )
      repaired = true
    }
  }

  if (isRecord(migrated.machine) && isRecord(migrated.project)) {
    const machineId = migrated.machine.id
    const storedMachineId = migrated.project.machineId
    if (
      typeof machineId === "string"
      && machineId.length > 0
      && typeof storedMachineId === "string"
      && storedMachineId !== machineId
    ) {
      migrated.project.machineId = machineId
      appendSystemReceipt(
        migrated,
        "Stored project machine reference repaired",
        `Updated project.machineId from ${storedMachineId} to ${machineId} while preserving project state.`,
      )
      repaired = true
    }
  }
  return finalizeStoredWorkspace(
    workspaceSnapshotSchema.parse(migrated),
    repaired,
    inactivatedRules,
  )
}

function finalizeStoredWorkspace(
  snapshot: WorkspaceSnapshot,
  repaired: boolean,
  inactivatedRules: Array<{ id: string; projectId: string; inactivatedAt: string }>,
): {
  snapshot: WorkspaceSnapshot
  repaired: boolean
  inactivatedRules: Array<{ id: string; projectId: string; inactivatedAt: string }>
} {
  const sanitized = redactWorkspaceCopies(snapshot)
  return {
    snapshot: sanitized,
    repaired: repaired || JSON.stringify(sanitized) !== JSON.stringify(snapshot),
    inactivatedRules,
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

// Moving a newer build's state aside would reset that build's workspace the
// next time it runs, so an older build refuses to open it and leaves it alone.
function newerStoredProtocol(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const version = protocolVersionSchema.safeParse(value.protocolVersion)
  if (!version.success) return undefined
  return protocolCompatibility(protocolVersion, version.data) === "machine-behind"
    ? version.data
    : undefined
}

function refuseNewerStoredState(path: string, stored: string): Error {
  const [major, minor] = stored.split(".")
  return new Error(
    `Stored state at ${path} was written by Domovoi protocol ${stored}, which is newer than this build's protocol ${protocolVersion}. ` +
    `This build left it unchanged. Run a Domovoi build that speaks protocol ${major}.${minor} or later to open it.`,
  )
}

function quotedColumn(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

// Reading the stored version must not change the file an older build is
// about to refuse, nor create or remove the -wal and -shm files another
// process may be using. With nothing pending in the write-ahead log the main
// file is read as immutable, which opens no sidecar. When the log holds
// changes, or this Node cannot open a URL path, a private copy is read.
// Only a missing table, a missing row or unreadable content means there is
// no stored version; an operational failure refuses the start. The daemon
// constructs its store only while it holds the profile lease, so no other
// daemon writes the file or its log during this read.
export function storedProtocolVersion(path: string): string | undefined {
  if (path === ":memory:" || !existsSync(path)) return undefined
  const walPath = `${path}-wal`
  try {
    return existsSync(walPath) && statSync(walPath).size > 0
      ? versionFromCopy(path)
      : versionFromImmutable(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isCorruption(error) || /no such table|malformed JSON/i.test(message)) return undefined
    throw error
  }
}

function readStoredVersion(database: DatabaseSync): string | undefined {
  const row = database
    .prepare("SELECT json_extract(snapshot, '$.protocolVersion') AS version FROM workspace_state WHERE id = 1")
    .get() as { version?: unknown } | undefined
  return typeof row?.version === "string" ? row.version : undefined
}

function versionFromImmutable(path: string): string | undefined {
  const location = pathToFileURL(path)
  location.searchParams.set("immutable", "1")
  let database: DatabaseSync
  try {
    database = new DatabaseSync(location, { readOnly: true })
  } catch (error) {
    if (error instanceof TypeError) return versionFromCopy(path)
    throw error
  }
  try {
    return readStoredVersion(database)
  } finally {
    database.close()
  }
}

function versionFromCopy(path: string): string | undefined {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-state-version-"))
  try {
    const copy = join(directory, "state.sqlite")
    copyFileSync(path, copy)
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`)
    const database = new DatabaseSync(copy, { readOnly: true })
    try {
      return readStoredVersion(database)
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function openQuarantined<T>(quarantinedPath: string, read: (source: DatabaseSync) => T): T | undefined {
  let source: DatabaseSync | undefined
  try {
    source = new DatabaseSync(quarantinedPath, { readOnly: true })
    return read(source)
  } catch {
    return undefined
  } finally {
    source?.close()
  }
}

// A database is moved aside whole, but its pairing table is often still
// readable. Copying it keeps every paired phone, and every revocation, working
// instead of refusing them all as if they had been revoked. Copied rows go
// through the registry's migrations again and each one must still read as a
// paired device; a row that does not is dropped and reported as not kept.
function salvagePairedDevices(database: DatabaseSync, quarantinedPath: string): boolean {
  const copied = openQuarantined(quarantinedPath, (source) => {
    const sourceColumns = (source.prepare("PRAGMA table_info(paired_devices)").all() as Array<{ name: string }>)
      .map(({ name }) => name)
    if (sourceColumns.length === 0) return { columns: [], rows: [] }
    const targetColumns = new Set(
      (database.prepare("PRAGMA table_info(paired_devices)").all() as Array<{ name: string }>).map(({ name }) => name),
    )
    const columns = sourceColumns.filter((name) => targetColumns.has(name)).map(quotedColumn)
    const rows = source.prepare(`SELECT ${columns.join(", ")} FROM paired_devices`).all() as Array<Record<string, SQLInputValue>>
    return { columns, rows }
  })
  if (!copied) return false
  if (copied.rows.length === 0) return true
  const insert = database.prepare(
    `INSERT INTO paired_devices (${copied.columns.join(", ")}) VALUES (${copied.columns.map(() => "?").join(", ")})`,
  )
  database.exec("BEGIN IMMEDIATE")
  try {
    for (const row of copied.rows) insert.run(...Object.values(row))
    void new SqliteDeviceRegistry(database)
    const invalid = (database.prepare("SELECT * FROM paired_devices").all() as Array<{ id: string }>)
      .filter((row) => !storedDeviceRowIsValid(row))
    const remove = database.prepare("DELETE FROM paired_devices WHERE id = ?")
    for (const row of invalid) remove.run(row.id)
    database.exec("COMMIT")
    return invalid.length === 0
  } catch {
    database.exec("ROLLBACK")
    return false
  }
}

// Damage elsewhere in the file can leave the workspace itself readable. Only a
// snapshot that passes the same migration and validation as a normal start is
// kept; project rows for other projects are kept when they validate the way
// loadProject reads them.
function salvageWorkspace(
  database: DatabaseSync,
  quarantinedPath: string,
): ReturnType<typeof migrateStoredWorkspace> | undefined {
  const snapshot = openQuarantined(quarantinedPath, (source) => (
    source.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get() as StoredWorkspace | undefined
  ))
  if (!snapshot) return undefined
  let migrated: ReturnType<typeof migrateStoredWorkspace>
  try {
    const value: unknown = JSON.parse(snapshot.snapshot)
    if (newerStoredProtocol(value) !== undefined) return undefined
    migrated = migrateStoredWorkspace(value)
  } catch {
    return undefined
  }
  const insert = database.prepare(`
    INSERT INTO workspace_projects (project_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO NOTHING
  `)
  const updatedAt = new Date().toISOString()
  // Other projects' rows are kept best effort: damage there never costs the
  // workspace that was read above.
  const projects = openQuarantined(quarantinedPath, (source) => (
    source.prepare("SELECT project_id, state FROM workspace_projects").all() as Array<{ project_id: string; state: string }>
  )) ?? []
  for (const project of projects) {
    if (project.project_id === migrated.snapshot.project?.id) continue
    try {
      const candidate = {
        ...JSON.parse(project.state) as Record<string, unknown>,
        protocolVersion,
        machine: migrated.snapshot.machine,
        skillEnablements: [],
      }
      workspaceSnapshotSchema.parse(redactWorkspaceCopies(candidate as unknown as WorkspaceSnapshot))
      insert.run(project.project_id, project.state, updatedAt)
    } catch {
      continue
    }
  }
  return migrated
}

type OpenedState = {
  database: DatabaseSync
  auditLog: SqliteAuditLog
  devices: SqliteDeviceRegistry
  fleet: SqliteFleetRegistry
  transferReceipts: SqliteTransferReceipts
  transferOwnership: SqliteTransferOwnership
  transferConflicts: SqliteTransferConflicts
  skillReviews: SqliteSkillReviews
  sessionCreations: SqliteSessionCreationIntents
  existing: StoredWorkspace | undefined
}

// Checking the whole file costs about 145 ms at 550 MB warm, and 0.6 s warm
// but 8.4 s cold at 2.2 GB, so a file past this bound skips it and damage there
// is found when a table is read, as before the check existed.
export const defaultIntegrityCheckMaximumBytes = 256 * 1024 * 1024

function stateBytes(path: string): number {
  const sizeOf = (file: string) => existsSync(file) ? statSync(file).size : 0
  return sizeOf(path) + sizeOf(`${path}-wal`)
}

// Everything that reads the file at startup runs here, so a damaged page in
// any table is found before the daemon starts rather than on its first read.
function openState(path: string, integrityCheckMaximumBytes: number): OpenedState {
  const database = openWorkspaceDatabase(path)
  try {
    if (path !== ":memory:" && stateBytes(path) <= integrityCheckMaximumBytes) {
      const problems = (database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>)
        .map((row) => row.quick_check)
        .filter((result) => result !== "ok")
      if (problems.length > 0) throw new Error(`database disk image is malformed: ${problems[0]}`)
    }
    const auditLog = new SqliteAuditLog(database)
    const opened = {
      database,
      auditLog,
      devices: new SqliteDeviceRegistry(database),
      fleet: new SqliteFleetRegistry(database, auditLog),
      transferReceipts: new SqliteTransferReceipts(database),
      transferOwnership: new SqliteTransferOwnership(database),
      transferConflicts: new SqliteTransferConflicts(database),
      skillReviews: new SqliteSkillReviews(database),
      sessionCreations: new SqliteSessionCreationIntents(database),
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS queued_session_sends (
        session_id TEXT PRIMARY KEY,
        queue_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    const existing = database
      .prepare("SELECT snapshot FROM workspace_state WHERE id = 1")
      .get() as StoredWorkspace | undefined
    return { ...opened, existing }
  } catch (error) {
    database.close()
    throw error
  }
}

function recoveryReceiptDetail(recovery: WorkspaceStoreRecovery): string {
  const subject = recovery.kind === "database" ? "state database" : "workspace snapshot"
  const devices = recovery.pairedDevicesKept
    ? "Paired devices were kept."
    : "Paired devices could not be read from it and must be paired again."
  const workspace = recovery.workspaceKept
    ? "Its workspace was readable and was kept."
    : "The workspace started empty."
  return `The stored ${subject} could not be read and was moved aside. ${workspace} ${devices} ${recovery.reason}`
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
  const redact = workerData.redactionUrl
    ? (await import(workerData.redactionUrl)).redactWorkspaceCopies
    : (snapshot) => snapshot
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
      const validated = workspaceSnapshotSchema.parse(redact(message.snapshot))
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
            workingPlans: validated.workingPlans,
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
      workerData: {
        path,
        protocolUrl: import.meta.resolve("@getdomovoi/protocol"),
        redactionUrl: workspaceRedactionModule,
      },
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
  readonly transferOwnership: SqliteTransferOwnership
  readonly transferConflicts: SqliteTransferConflicts
  readonly skillReviews: SqliteSkillReviews
  readonly sessionCreations: SqliteSessionCreationIntents
  readonly recovery: WorkspaceStoreRecovery | undefined
  #database: DatabaseSync
  #writer: WorkspaceWriter | undefined
  #writerFactory: WorkspaceStoreOptions["writerFactory"]
  #writerClosed = false
  #databaseClosed = false

  constructor(path: string, initial: WorkspaceSnapshot, options: WorkspaceStoreOptions = {}) {
    this.path = path
    const manageDirectoryPermissions = options.manageDirectoryPermissions === true
    const storedVersion = storedProtocolVersion(path)
    const newerVersion = storedVersion === undefined ? undefined : newerStoredProtocol({ protocolVersion: storedVersion })
    if (newerVersion !== undefined) throw refuseNewerStoredState(path, newerVersion)
    if (path !== ":memory:") prepareStatePath(path, manageDirectoryPermissions)
    let recovery: WorkspaceStoreRecovery | undefined
    let salvagedWorkspace: ReturnType<typeof migrateStoredWorkspace> | undefined
    const integrityCheckMaximumBytes = options.integrityCheckMaximumBytes ?? defaultIntegrityCheckMaximumBytes
    let opened: OpenedState
    try {
      opened = openState(path, integrityCheckMaximumBytes)
    } catch (error) {
      if (path === ":memory:") throw error
      // An operational failure is reported to the caller rather than repaired,
      // so a locked or unreadable file is never renamed aside.
      if (!isCorruption(error)) throw error
      const quarantinedPath = quarantineDatabase(path)
      prepareStatePath(path, manageDirectoryPermissions)
      opened = openState(path, integrityCheckMaximumBytes)
      salvagedWorkspace = salvageWorkspace(opened.database, quarantinedPath)
      recovery = {
        kind: "database",
        quarantinedPath,
        reason: describeFailure(error),
        occurredAt: new Date().toISOString(),
        pairedDevicesKept: salvagePairedDevices(opened.database, quarantinedPath),
        workspaceKept: salvagedWorkspace !== undefined,
      }
    }
    this.#database = opened.database
    this.#writerFactory = options.writerFactory
    this.auditLog = opened.auditLog
    this.devices = opened.devices
    this.fleet = opened.fleet
    this.transferReceipts = opened.transferReceipts
    this.transferOwnership = opened.transferOwnership
    this.transferConflicts = opened.transferConflicts
    this.skillReviews = opened.skillReviews
    this.sessionCreations = opened.sessionCreations

    const existing = opened.existing
    let migratedExisting: ReturnType<typeof migrateStoredWorkspace> | undefined
    if (existing) {
      let stored: { value: unknown } | undefined
      try {
        stored = { value: JSON.parse(existing.snapshot) }
      } catch {
        stored = undefined
      }
      const newer = stored ? newerStoredProtocol(stored.value) : undefined
      if (newer !== undefined) {
        this.#database.close()
        this.#databaseClosed = true
        throw refuseNewerStoredState(path, newer)
      }
      try {
        migratedExisting = migrateStoredWorkspace(stored ? stored.value : JSON.parse(existing.snapshot))
      } catch (error) {
        recovery = {
          kind: "snapshot",
          quarantinedPath: quarantineSnapshot(path, existing.snapshot),
          reason: describeFailure(error),
          occurredAt: new Date().toISOString(),
          pairedDevicesKept: true,
          workspaceKept: false,
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
    if (recovery) {
      this.auditLog.append({
        occurredAt: recovery.occurredAt,
        actor: { kind: "daemon", component: "state-store" },
        action: "state.quarantine",
        outcome: "succeeded",
        target: recovery.quarantinedPath,
        detail: recoveryReceiptDetail(recovery),
      })
      if (salvagedWorkspace) {
        this.save(salvagedWorkspace.snapshot)
        this.#recordRuleInactivations(salvagedWorkspace.inactivatedRules)
      } else {
        this.save(recoveredWorkspace(initial, recovery))
      }
    }
    else if (!existing) this.save(initial)
    else if (migratedExisting?.repaired) {
      this.save(migratedExisting.snapshot)
      this.#recordRuleInactivations(migratedExisting.inactivatedRules)
    }
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
        this.#recordRuleInactivations(migrated.inactivatedRules)
      } catch {
        return this.transferConflicts.restore(migrated.snapshot)
      }
    }
    return this.transferConflicts.restore(migrated.snapshot)
  }

  save(snapshot: WorkspaceSnapshot): void {
    const validated = workspaceSnapshotSchema.parse(redactWorkspaceCopies(snapshot))
    this.#writeValidated(validated)
  }

  async saveAsync(snapshot: WorkspaceSnapshot): Promise<void> {
    if (this.path === ":memory:") {
      await new Promise<void>((resolve) => setImmediate(resolve))
      this.#writeValidated(workspaceSnapshotSchema.parse(redactWorkspaceCopies(snapshot)))
      return
    }
    if (this.#writer?.failed && !this.#writerClosed) this.#writer = undefined
    this.#writer ??= this.#writerFactory?.(this.path) ?? new AsyncWorkspaceWriter(this.path)
    // The built-in worker redacts when it can load the module. A custom writer
    // does not share that contract, and an unresolved module cannot be trusted,
    // so those paths still receive a redacted snapshot from the main thread.
    await this.#writer.write(
      workspaceRedactionModule && !this.#writerFactory
        ? snapshot
        : redactWorkspaceCopies(snapshot),
    )
  }

  saveTransferredSnapshot(
    snapshot: WorkspaceSnapshot,
    rawOwnership: CommittedTransferOwnership,
  ): void {
    const validated = workspaceSnapshotSchema.parse(redactWorkspaceCopies(snapshot))
    const ownership = committedTransferOwnershipSchema.parse(rawOwnership)
    const session = validated.sessions.find((candidate) => candidate.id === ownership.sessionId)
    const origin = session?.transferredFrom
    if (
      validated.machine.id !== ownership.targetMachineId
      || validated.project?.id !== ownership.targetProjectId
      || session?.projectId !== ownership.targetProjectId
      || session.workspacePath !== ownership.workspacePath
      || session.ownershipGeneration !== ownership.generation
      || origin?.transferId !== ownership.transferId
      || origin.sourceMachineId !== ownership.sourceMachineId
      || origin.manifestDigest !== ownership.manifestDigest
      || origin.generation !== ownership.generation
      || origin.checkpointCommit !== ownership.checkpointCommit
      || origin.completedAt !== ownership.completedAt
    ) {
      throw new Error("Transferred snapshot does not match its ownership record")
    }

    const updatedAt = new Date().toISOString()
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      this.#writeValidatedRows(validated, updatedAt)
      this.transferOwnership.record(ownership)
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
    this.#restrictFilePermissions()
  }

  loadQueuedSessionSends(): StoredQueuedSessionSend[] {
    return (this.#database.prepare(`
      SELECT session_id, queue_id, state, payload
      FROM queued_session_sends
      ORDER BY created_at, queue_id
    `).all() as StoredQueuedSessionSendRow[]).map(parseStoredQueuedSessionSend)
  }

  replaceQueuedSessionSend(queued: StoredQueuedSessionSend): void {
    const metadata = queuedSessionSendSchema.parse({
      id: queued.id,
      sessionId: queued.sessionId,
      state: queued.state === "releasing" ? "unconfirmed" : queued.state,
      createdAt: queued.createdAt,
      origin: queued.origin,
      skillIds: queued.skillIds,
      attachments: queued.attachments,
      ...(queued.reason ? { reason: queued.reason } : {}),
    })
    sessionSendParamsSchema.parse({
      sessionId: queued.sessionId,
      prompt: queued.prompt,
      client: queued.origin.client,
      ...(queued.skillSelection ? { skillSelection: queued.skillSelection } : {}),
      ...(queued.uploads ? { attachments: queued.uploads } : {}),
      delivery: "next-turn-replace",
    })
    this.#database.prepare(`
      INSERT INTO queued_session_sends (session_id, queue_id, state, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        queue_id = excluded.queue_id,
        state = excluded.state,
        payload = excluded.payload,
        created_at = excluded.created_at
    `).run(
      queued.sessionId,
      queued.id,
      queued.state,
      JSON.stringify({
        createdAt: queued.createdAt,
        origin: queued.origin,
        skillIds: queued.skillIds,
        attachments: queued.attachments,
        prompt: queued.prompt,
        ...(queued.skillSelection ? { skillSelection: queued.skillSelection } : {}),
        ...(queued.uploads ? { uploads: queued.uploads } : {}),
        ...(queued.credentialDeviceId ? { credentialDeviceId: queued.credentialDeviceId } : {}),
        ...(queued.reason ? { reason: queued.reason } : {}),
      }),
      metadata.createdAt,
    )
    this.#restrictFilePermissions()
  }

  transitionQueuedSessionSend(
    sessionId: string,
    queueId: string,
    from: StoredQueuedSessionSend["state"][],
    to: StoredQueuedSessionSend["state"],
    reason?: string,
  ): boolean {
    const row = this.#database.prepare(`
      SELECT session_id, queue_id, state, payload
      FROM queued_session_sends
      WHERE session_id = ? AND queue_id = ?
    `).get(sessionId, queueId) as StoredQueuedSessionSendRow | undefined
    if (!row || !from.includes(row.state as StoredQueuedSessionSend["state"])) return false
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    if (reason === undefined) delete payload.reason
    else payload.reason = reason
    const result = this.#database.prepare(`
      UPDATE queued_session_sends
      SET state = ?, payload = ?
      WHERE session_id = ? AND queue_id = ? AND state = ?
    `).run(to, JSON.stringify(payload), sessionId, queueId, row.state)
    return result.changes === 1
  }

  transitionQueuedSessionSends(transitions: readonly QueuedSessionSendTransition[]): boolean[] {
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const results = transitions.map((transition) => this.transitionQueuedSessionSend(
        transition.sessionId,
        transition.queueId,
        transition.from,
        transition.to,
        transition.reason,
      ))
      this.#database.exec("COMMIT")
      return results
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  deleteQueuedSessionSend(sessionId: string, queueId: string): boolean {
    return this.#database.prepare(`
      DELETE FROM queued_session_sends WHERE session_id = ? AND queue_id = ?
    `).run(sessionId, queueId).changes === 1
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
    return projectWorkspaceState(this.transferConflicts.restore(
      workspaceSnapshotSchema.parse(redactWorkspaceCopies(candidate)),
    ))
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
    this.#writeValidatedRows(snapshot, updatedAt)
    this.#restrictFilePermissions()
  }

  #writeValidatedRows(snapshot: WorkspaceSnapshot, updatedAt: string): void {
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
  }

  #recordRuleInactivations(
    rules: ReadonlyArray<{ id: string; projectId: string; inactivatedAt: string }>,
  ): void {
    for (const rule of rules) {
      this.auditLog.append({
        occurredAt: rule.inactivatedAt,
        actor: { kind: "daemon", component: "workspace-migration" },
        action: "approval-rule.inactivated",
        outcome: "succeeded",
        projectId: rule.projectId,
        target: rule.id,
        detail: "Legacy standing approval requires explicit reapproval with a resolved execution fingerprint.",
      })
    }
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
