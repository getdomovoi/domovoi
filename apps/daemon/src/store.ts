import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { ZodError } from "zod"

import {
  dateTimeSchema,
  executionResolutionSchema,
  knownProjectSchema,
  knownProjectSessionSchema,
  machineIdSchema,
  maximumKnownSessionTitleLength,
  projectSchema,
  protocolCompatibility,
  protocolVersion,
  protocolVersionSchema,
  queuedSessionSendSchema,
  resolvedExecutionSchema,
  sessionSendParamsSchema,
  workspaceSnapshotSchema,
  workspaceProjects,
  type KnownProject,
  type KnownProjectSession,
  type QueuedSessionSend,
  type SessionAttachment,
  type SessionSendReview,
  type StateRecovery,
  type TurnSkillSelection,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { normalizeLegacyEffort } from "./legacy-effort.js"
import { SqliteAuditLog, type AuditLog } from "./audit-log.js"
import { SqliteDeviceRegistry, storedDeviceRowIsValid, type DeviceRegistry } from "./device-registry.js"
import { SqliteTransferReceipts, type TransferReceipts } from "./transfer-receipts.js"
import { SqliteFleetRegistry, type FleetRegistry } from "./fleet-registry.js"
import { SqliteSkillReviews, type SkillReviews } from "./skill-reviews.js"
import { SqliteRepositoryTrust, type RepositoryTrustStore } from "./repository-trust-store.js"
import {
  committedTransferOwnershipSchema,
  SqliteTransferOwnership,
  type CommittedTransferOwnership,
  type TransferOwnership,
} from "./transfer-ownership.js"
import {
  SqliteTransferConflicts,
} from "./transfer-conflicts.js"
import { createWorkspaceRedactor, redactWorkspaceCopies } from "./workspace-redaction.js"
import { SqliteEmergencyStopIntents } from "./emergency-stop-intents.js"
import { SqliteSessionCreationIntents } from "./session-creation-intents.js"

type StoredWorkspace = {
  snapshot: string
}

export type WorkspaceStoreRecovery = StateRecovery & { quarantinedPath: string; reason: string }

type StoredProjectWorkspace = {
  state: string
}

// A saved project as project.list reads it, before the daemon looks for its
// folder: its sessions newest first, at most the limit asked for.
export type SavedProject = Omit<KnownProject, "folder">

export type SavedProjectListing = {
  projects: SavedProject[]
  // Ids of rows that did not read as one project's own state.
  unreadable: string[]
}

function savedProjectListing(
  row: { project_id: string; updated_at: string; project: string | null; sessions: string | null },
  sessionLimit: number,
): SavedProject | undefined {
  if (row.project === null || row.sessions === null) return undefined
  const savedAt = dateTimeSchema.safeParse(row.updated_at)
  const project = projectSchema.safeParse(JSON.parse(row.project))
  if (!savedAt.success || !project.success || project.data.id !== row.project_id) return undefined
  const stored: unknown = JSON.parse(row.sessions)
  if (!Array.isArray(stored)) return undefined
  const sessions: KnownProjectSession[] = []
  for (const value of stored) {
    if (!isRecord(value) || value.projectId !== row.project_id) return undefined
    // A title is listed whole up to the list's bound; a longer one, which
    // nothing creates today, is cut there rather than costing the row.
    const title = typeof value.title === "string" ? value.title.slice(0, maximumKnownSessionTitleLength) : value.title
    const session = knownProjectSessionSchema.safeParse({ id: value.id, title, state: value.state, updatedAt: value.updatedAt })
    if (!session.success) return undefined
    sessions.push(session.data)
  }
  sessions.sort((left, right) => (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
  ))
  const omittedSessions = sessions.length - sessionLimit
  const saved: SavedProject = {
    project: project.data,
    savedAt: savedAt.data,
    sessions: sessions.slice(0, sessionLimit),
    ...(omittedSessions > 0 ? { omittedSessions } : {}),
  }
  // The whole entry meets the protocol's own rules (a session listed twice,
  // say), so one row can never make the list fail its schema.
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) return undefined
  return knownProjectSchema.safeParse({ ...saved, folder: "present" }).success ? saved : undefined
}

type StoredQueuedSessionSendRow = {
  session_id: string
  queue_id: string
  state: string
  payload: string
}

type StoredQueuedSessionSendRowWithId = StoredQueuedSessionSendRow & { row_id: number | bigint }

export type UnreadableQueuedSessionSend = {
  sessionId: string
  queueId: string
  reason: string
  // False when the row could not be moved aside; it stays in place and the
  // next load tries again.
  quarantined: boolean
}

// A transition reason can carry a provider or RPC error message. The loader
// validates it with the wire bounds, so the writer applies the same bounds.
export function boundedQueuedSendReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim()
  if (!trimmed) return undefined
  return queuedSessionSendSchema.shape.reason.parse(trimmed.slice(0, 1_024).trim())
}

export type StoredQueuedSessionSend = Omit<QueuedSessionSend, "state"> & {
  state: "waiting" | "held" | "refused" | "releasing" | "unconfirmed"
  prompt: string
  skillSelection?: TurnSkillSelection
  uploads?: SessionAttachment[]
  review?: SessionSendReview
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
  queuedSends?: WorkspaceSnapshot["queuedSends"]
  turns?: WorkspaceSnapshot["turns"]
}

// Self-contained: the worker embeds this same function, so synchronous and
// asynchronous persistence cannot disagree about which project owns a record.
function workspaceStorageRows(snapshot: WorkspaceSnapshot): { workspace: WorkspaceSnapshot; projects: ProjectWorkspaceState[] } {
  const projects = snapshot.projects ?? (snapshot.project ? [snapshot.project] : [])
  const several = projects.length > 1
  const states = projects.map((project): ProjectWorkspaceState => {
    const sessions = snapshot.sessions.filter((session) => session.projectId === project.id)
    const ids = new Set(sessions.map((session) => session.id))
    return {
      project, sessions,
      activeSessionId: snapshot.activeSessionId !== null && ids.has(snapshot.activeSessionId) ? snapshot.activeSessionId : null,
      approvals: snapshot.approvals.filter((approval) => ids.has(approval.sessionId)),
      approvalRules: snapshot.approvalRules.filter((rule) => rule.projectId === project.id),
      thread: snapshot.thread.filter((item) => ids.has(item.sessionId)),
      artifacts: snapshot.artifacts.filter((artifact) => ids.has(artifact.sessionId)),
      workingPlans: snapshot.workingPlans.filter((plan) => ids.has(plan.sessionId)),
      annotations: snapshot.annotations.filter((annotation) => ids.has(annotation.sessionId)),
      ...(several && snapshot.queuedSends !== undefined ? { queuedSends: snapshot.queuedSends.filter((queued) => ids.has(queued.sessionId)) } : {}),
      ...(several && snapshot.turns !== undefined ? { turns: snapshot.turns.filter((turn) => ids.has(turn.sessionId)) } : {}),
    }
  })
  const focused = states.find((state) => state.project.id === snapshot.project?.id)
  if (several && focused?.activeSessionId !== snapshot.activeSessionId) {
    throw new Error("The active session must belong to the focused project")
  }
  const { projects: _projects, projectCap: _cap, ...legacy } = snapshot
  return {
    // The projects list is also the downgrade guard: the S1 reader recognizes
    // another active id and refuses before opening the database for writes.
    workspace: several ? { ...snapshot, ...focused } : legacy,
    projects: states,
  }
}

export function projectWorkspaceState(snapshot: WorkspaceSnapshot): ProjectWorkspaceState | undefined {
  return workspaceStorageRows(snapshot).projects.find((state) => state.project.id === snapshot.project?.id)
}

// A close writes the saved project and the remaining active workspace in one
// transaction. Shared with the worker so neither path can omit the saved row.
function closedProjectRows(snapshot: WorkspaceSnapshot, closed: WorkspaceSnapshot): ProjectWorkspaceState[] {
  const projects = closed.projects ?? (closed.project ? [closed.project] : [])
  if (projects.length !== 1 || !closed.project || closed.machine.id !== snapshot.machine.id
    || (snapshot.projects ?? (snapshot.project ? [snapshot.project] : [])).some((project) => project.id === closed.project!.id)
    || closed.sessions.some((session) => session.activeTurnId !== undefined)
    || closed.approvals.length > 0) throw new Error("Invalid closed project state")
  const rows = workspaceStorageRows(closed).projects
  // One-project legacy rows omit these optional fields on ordinary saves.
  // A closed row must retain its final turn and queued-send metadata too.
  return rows.map((row) => ({ ...row,
    ...(closed.turns === undefined ? {} : { turns: closed.turns }),
    ...(closed.queuedSends === undefined ? {} : { queuedSends: closed.queuedSends }),
  }))
}

export interface WorkspaceStore {
  readonly auditLog?: AuditLog
  readonly devices?: DeviceRegistry
  readonly fleet?: FleetRegistry
  readonly transferReceipts?: TransferReceipts
  readonly transferOwnership?: TransferOwnership
  readonly transferConflicts?: SqliteTransferConflicts
  readonly skillReviews?: SkillReviews
  readonly repositoryTrust?: RepositoryTrustStore
  readonly sessionCreations?: SqliteSessionCreationIntents
  readonly emergencyStops?: SqliteEmergencyStopIntents
  readonly recovery?: WorkspaceStoreRecovery | undefined
  load(): WorkspaceSnapshot
  loadProject?(projectId: string, machine?: WorkspaceSnapshot["machine"]): ProjectWorkspaceState | undefined
  listProjects?(sessionLimit: number): SavedProjectListing
  save(snapshot: WorkspaceSnapshot): void
  saveAsync?(snapshot: WorkspaceSnapshot): Promise<void>
  saveProjectClose?(snapshot: WorkspaceSnapshot, closed: WorkspaceSnapshot): void
  saveProjectCloseAsync?(snapshot: WorkspaceSnapshot, closed: WorkspaceSnapshot): Promise<void>
  saveTransferredSnapshot?(
    snapshot: WorkspaceSnapshot,
    ownership: CommittedTransferOwnership,
  ): void | Promise<void>
  loadQueuedSessionSends?(onUnreadable?: (unreadable: UnreadableQueuedSessionSend) => void): StoredQueuedSessionSend[]
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
  writeProjectClose?(snapshot: WorkspaceSnapshot, closed: WorkspaceSnapshot): Promise<void>
  close(): Promise<void>
}

export type WorkspaceStoreOptions = {
  // Restoration is enabled by default. False exercises the downgrade guard.
  restoreActiveProjects?: boolean
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
    ...(payload.review === undefined ? {} : { review: payload.review }),
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
    ...(send.review ? { review: send.review } : {}),
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

function migrateStoredWorkspace(value: unknown, options: { repairLegacyEffort?: boolean; restoreActiveProjects?: boolean } = {}): {
  snapshot: WorkspaceSnapshot
  repaired: boolean
  inactivatedRules: Array<{ id: string; projectId: string; inactivatedAt: string }>
} {
  if (!isRecord(value)) {
    return finalizeStoredWorkspace(workspaceSnapshotSchema.parse(value), false, [])
  }
  const migrated = structuredClone(value)
  // Single-project storage keeps its legacy shape. A validated multi-project
  // load keeps the active list; dropping it would orphan the rehydrated records.
  if (!options.restoreActiveProjects || !Array.isArray(migrated.projects) || migrated.projects.length <= 1) {
    delete migrated.projects
    delete migrated.projectCap
  }
  let repaired = false
  // These reviewed predecessors retain their state. Rules from 0.6 gain a zero
  // use count below; full validation still runs before any migrated write.
  if (typeof migrated.protocolVersion === "string" && /^0\.(?:3|6|7)\.\d+$/.test(migrated.protocolVersion)) {
    migrated.protocolVersion = protocolVersion
    repaired = true
  }
  const inactivatedRules: Array<{ id: string; projectId: string; inactivatedAt: string }> = []
  // Before discovery reported unset, OpenCode and Kilo sent no effort value
  // for medium or none. Normalize these labels on every load; revisit this
  // repair if either adapter ever sends a real effort value.
  if (options.repairLegacyEffort !== false && Array.isArray(migrated.sessions)) {
    for (const session of migrated.sessions) {
      if (!isRecord(session) || !isRecord(session.runtime)) continue
      const runtime = session.runtime
      if (typeof runtime.provider !== "string" || typeof runtime.reasoning !== "string") continue
      const reasoning = normalizeLegacyEffort(runtime.provider, runtime.reasoning)
      if (reasoning !== runtime.reasoning) {
        runtime.reasoning = reasoning
        repaired = true
      }
    }
  }
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

// State a newer daemon wrote is left exactly as it is. Reading it would mean
// guessing at fields this daemon does not know, and moving it aside would
// replace a person's sessions with the seed. The daemon does not start.
export class NewerWorkspaceStateError extends Error {
  constructor(
    readonly path: string,
    readonly storedProtocolVersion: string,
    readonly daemonProtocolVersion: string,
  ) {
    const minor = storedProtocolVersion.split(".").slice(0, 2).join(".")
    super(`Domovoi state at ${path} was written by a newer daemon (protocol ${storedProtocolVersion}), and this daemon speaks protocol ${daemonProtocolVersion}. It was left as it is and this daemon did not start. Run the newer Domovoi again, or update this one to protocol ${minor} or later.`)
    this.name = "NewerWorkspaceStateError"
  }
}

// Retained for the explicit legacy-reader mode and its downgrade regression.
// Readers that keep one project open must refuse multi-project state before
// writing, rather than serve another project's records under their focus.
export class MultiProjectWorkspaceStateError extends NewerWorkspaceStateError {
  constructor(path: string, storedProtocolVersion: string) {
    super(path, storedProtocolVersion, protocolVersion)
    this.message = `Domovoi state at ${path} was written by a newer Domovoi that keeps several projects open, and this daemon keeps one project open at a time. It was left as it is and this daemon did not start. Run the newer Domovoi again.`
    this.name = "MultiProjectWorkspaceStateError"
  }
}

// Stored state lists a project other than the focused one, or holds a session
// or approval rule of another project, with or without a list (ruling Q258).
// Legacy readers refuse it; current readers must restore every active row.
// Moving it aside as corrupt would replace that project's work with the seed.
function keepsSeveralProjects(value: unknown): boolean {
  if (!isRecord(value)) return false
  const focused = isRecord(value.project) ? value.project.id : undefined
  const another = (projectId: unknown) => projectId !== focused
  if (Array.isArray(value.projects) && value.projects.some((project) => !isRecord(project) || another(project.id))) return true
  const records = (field: string): unknown[] => {
    const listed = value[field]
    return Array.isArray(listed) ? listed : []
  }
  return [...records("sessions"), ...records("approvalRules")]
    .some((record) => isRecord(record) && another(record.projectId))
}

// A saved project row holds that project's records only: its own project
// under its own key, no list naming another, and no session or approval rule
// of another. Anything else is what a newer Domovoi that keeps several
// projects open wrote, and is neither opened nor salvaged (ruling Q259).
export const savedProjectStateRefusal =
  "The saved state for this project holds another project's sessions or rules, as a newer Domovoi that keeps several projects open writes it. It was left as it is. Open this project with that version."

export class SavedProjectStateError extends Error {
  constructor(readonly projectId: string) {
    super(savedProjectStateRefusal)
    this.name = "SavedProjectStateError"
  }
}

function holdsOneProject(value: unknown, projectId: string): boolean {
  return isRecord(value)
    && isRecord(value.project)
    && value.project.id === projectId
    && !keepsSeveralProjects(value)
}

function refuseSeveralProjects(path: string, value: unknown): MultiProjectWorkspaceStateError {
  const stored = isRecord(value) && typeof value.protocolVersion === "string" ? value.protocolVersion : protocolVersion
  return new MultiProjectWorkspaceStateError(path, stored)
}

export class UnreadableActiveProjectStateError extends Error {
  constructor() {
    super("An active project state is unreadable or inconsistent. Domovoi did not start and left the stored state unchanged. Restore a complete state backup or use the Domovoi version that wrote it.")
    this.name = "UnreadableActiveProjectStateError"
  }
}

function restoreActiveWorkspace(value: unknown, database: DatabaseSync): WorkspaceSnapshot {
  try {
    const focused = workspaceSnapshotSchema.parse(value)
    if (!focused.project || !focused.projects || focused.projects.length < 2) throw new UnreadableActiveProjectStateError()
    const { projects: _projects, projectCap: _cap, ...onlyFocused } = focused
    // The workspace row contains only focused-project records. Accepting a
    // mixed row here would silently discard records when rebuilding from rows.
    workspaceSnapshotSchema.parse(onlyFocused)
    const states = focused.projects.map((project) => {
      const row = database.prepare("SELECT state FROM workspace_projects WHERE project_id = ?").get(project.id) as StoredProjectWorkspace | undefined
      if (!row) throw new UnreadableActiveProjectStateError()
      let raw: unknown
      try { raw = JSON.parse(row.state) } catch (error) {
        if (error instanceof SyntaxError) throw new UnreadableActiveProjectStateError()
        throw error
      }
      if (!holdsOneProject(raw, project.id)) throw new UnreadableActiveProjectStateError()
      const parsed = workspaceSnapshotSchema.parse({
        ...(raw as Record<string, unknown>), protocolVersion: focused.protocolVersion,
        machine: focused.machine, skillEnablements: [],
      })
      if (JSON.stringify(parsed.project) !== JSON.stringify(project)) throw new UnreadableActiveProjectStateError()
      if (project.id === focused.project!.id) {
        // Both copies are written in the same transaction and must agree.
        const rowState = { ...projectWorkspaceState(parsed), queuedSends: parsed.queuedSends, turns: parsed.turns }
        const focusState = { ...projectWorkspaceState(focused), queuedSends: focused.queuedSends, turns: focused.turns }
        if (JSON.stringify(rowState) !== JSON.stringify(focusState)) throw new UnreadableActiveProjectStateError()
      }
      return parsed
    })
    return workspaceSnapshotSchema.parse({
      ...focused,
      sessions: states.flatMap((state) => state.sessions),
      approvals: states.flatMap((state) => state.approvals),
      approvalRules: states.flatMap((state) => state.approvalRules),
      thread: states.flatMap((state) => state.thread),
      artifacts: states.flatMap((state) => state.artifacts),
      workingPlans: states.flatMap((state) => state.workingPlans),
      annotations: states.flatMap((state) => state.annotations),
      ...(states.some((state) => state.queuedSends !== undefined) ? { queuedSends: states.flatMap((state) => state.queuedSends ?? []) } : {}),
      ...(states.some((state) => state.turns !== undefined) ? { turns: states.flatMap((state) => state.turns ?? []) } : {}),
    })
  } catch (error) {
    // Validation details can carry secrets. Operational errors and programming
    // failures retain their identity instead of masquerading as damaged state.
    if (error instanceof ZodError) throw new UnreadableActiveProjectStateError()
    throw error
  }
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

function refuseNewerStoredState(path: string, stored: string): NewerWorkspaceStateError {
  return new NewerWorkspaceStateError(path, stored, protocolVersion)
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
  return readStoredState(path, readStoredVersion)
}

// The stored workspace snapshot, read the same way and with the same limits,
// before the store opens the file: the protocol that wrote it and whether it
// keeps several projects decide whether this daemon opens it at all.
function storedSnapshotValue(path: string, restoreActiveProjects = false): unknown {
  return readStoredState(path, (database) => {
    const row = database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get() as StoredWorkspace | undefined
    if (!row) return undefined
    let value: unknown
    try { value = JSON.parse(row.snapshot) } catch { return undefined }
    return restoreActiveProjects && newerStoredProtocol(value) === undefined && keepsSeveralProjects(value)
      ? restoreActiveWorkspace(value, database)
      : value
  })
}

function readStoredState<T>(path: string, read: (database: DatabaseSync) => T | undefined): T | undefined {
  if (path === ":memory:" || !existsSync(path)) return undefined
  const walPath = `${path}-wal`
  try {
    return existsSync(walPath) && statSync(walPath).size > 0
      ? readFromCopy(path, read)
      : readFromImmutable(path, read)
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

function readFromImmutable<T>(path: string, read: (database: DatabaseSync) => T | undefined): T | undefined {
  const location = pathToFileURL(path)
  location.searchParams.set("immutable", "1")
  let database: DatabaseSync
  try {
    database = new DatabaseSync(location, { readOnly: true })
  } catch (error) {
    if (error instanceof TypeError) return readFromCopy(path, read)
    throw error
  }
  try {
    return read(database)
  } finally {
    database.close()
  }
}

function readFromCopy<T>(path: string, read: (database: DatabaseSync) => T | undefined): T | undefined {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-state-version-"))
  try {
    const copy = join(directory, "state.sqlite")
    copyFileSync(path, copy)
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`)
    const database = new DatabaseSync(copy, { readOnly: true })
    try {
      return read(database)
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// SQLite ends a transaction itself on some errors, such as a full database; a
// ROLLBACK then fails with "no transaction is active" and would replace the
// error that ended it. isTransaction is absent before Node 22.16, so that one
// error is tolerated there.
function rollBackIfOpen(database: DatabaseSync): void {
  const open = (database as { isTransaction?: boolean }).isTransaction
  if (open === false) return
  try {
    database.exec("ROLLBACK")
  } catch (error) {
    if (open === undefined && error instanceof Error && error.message.includes("no transaction is active")) return
    throw error
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
    rollBackIfOpen(database)
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
    // Refused before the move when it could be read there. If only the moved
    // copy reads, it is left in that copy rather than cut to one project.
    if (keepsSeveralProjects(value)) return undefined
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
      const state = JSON.parse(project.state) as unknown
      if (!holdsOneProject(state, project.project_id)) continue
      const candidate = {
        ...state as Record<string, unknown>,
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
  repositoryTrust: SqliteRepositoryTrust
  sessionCreations: SqliteSessionCreationIntents
  emergencyStops: SqliteEmergencyStopIntents
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
      repositoryTrust: new SqliteRepositoryTrust(database),
      sessionCreations: new SqliteSessionCreationIntents(database),
      emergencyStops: new SqliteEmergencyStopIntents(database),
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
const workspaceStorageRows = ${workspaceStorageRows.toString()}
const closedProjectRows = ${closedProjectRows.toString()}
const { existsSync, chmodSync } = require("node:fs")
const { DatabaseSync } = require("node:sqlite")
const { parentPort, workerData } = require("node:worker_threads")

async function start() {
  const { workspaceSnapshotSchema } = await import(workerData.protocolUrl)
  // One redactor for the worker's life, so a write while a provider streams
  // redacts the thread items that changed since the last one. A module built
  // before the redactor existed still redacts the whole snapshot.
  const redaction = workerData.redactionUrl ? await import(workerData.redactionUrl) : undefined
  const redact = redaction
    ? (redaction.createWorkspaceRedactor?.() ?? redaction.redactWorkspaceCopies)
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
    "ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at " +
    "WHERE workspace_projects.state <> excluded.state",
  )
  parentPort.on("message", (message) => {
    try {
      if (message.close) {
        database.close()
        parentPort.postMessage({ id: message.id })
        return
      }
      const validated = workspaceSnapshotSchema.parse(redact(message.snapshot))
      const rows = workspaceStorageRows(validated)
      if (message.closed) rows.projects.push(...closedProjectRows(validated, workspaceSnapshotSchema.parse(redact(message.closed))))
      database.exec("BEGIN IMMEDIATE")
      try {
        save.run(JSON.stringify(rows.workspace), message.updatedAt)
        for (const state of rows.projects) {
          saveProject.run(state.project.id, JSON.stringify(state), message.updatedAt)
        }
        database.exec("COMMIT")
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
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

  writeProjectClose(snapshot: WorkspaceSnapshot, closed: WorkspaceSnapshot): Promise<void> {
    return this.#request({ snapshot, closed, updatedAt: new Date().toISOString() })
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
  readonly repositoryTrust: SqliteRepositoryTrust
  readonly sessionCreations: SqliteSessionCreationIntents
  readonly emergencyStops: SqliteEmergencyStopIntents
  readonly recovery: WorkspaceStoreRecovery | undefined
  #database: DatabaseSync
  readonly #restoreActiveProjects: boolean
  #writer: WorkspaceWriter | undefined
  #writerFactory: WorkspaceStoreOptions["writerFactory"]
  #writerClosed = false
  #databaseClosed = false
  // The constructor has already read and migrated the stored snapshot, so the
  // first load hands that copy over instead of reading it all again. Any
  // write drops it, and every later load reads the row.
  #migratedAtOpen: WorkspaceSnapshot | undefined
  // The asynchronous writes that redact on this thread (an in-memory store, a
  // custom writer, or a worker without the redaction module) share one
  // redactor, so a write while a provider streams redacts only the thread
  // items that changed. The persistence worker keeps its own. The rare
  // synchronous save redacts whole, so it does not hold a thread copy here.
  readonly #redact = createWorkspaceRedactor()

  constructor(path: string, initial: WorkspaceSnapshot, options: WorkspaceStoreOptions = {}) {
    this.path = path
    this.#restoreActiveProjects = options.restoreActiveProjects !== false
    const manageDirectoryPermissions = options.manageDirectoryPermissions === true
    // The stored snapshot is read before the file is opened for writing, from
    // the file as it is or from a private copy when the write-ahead log holds
    // changes: opening the live files would checkpoint that log into the main
    // file and remove it. State this daemon must not open is refused here,
    // with nothing on disk changed (rulings Q257 to Q259).
    const storedValue = storedSnapshotValue(path, this.#restoreActiveProjects)
    const newerVersion = newerStoredProtocol(storedValue)
    if (newerVersion !== undefined) throw refuseNewerStoredState(path, newerVersion)
    if (!this.#restoreActiveProjects && keepsSeveralProjects(storedValue)) throw refuseSeveralProjects(path, storedValue)
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
      if (keepsSeveralProjects(storedValue)) throw new UnreadableActiveProjectStateError()
      // State with several projects was refused above, before anything moved,
      // when the workspace row could be read.
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
    this.repositoryTrust = opened.repositoryTrust
    this.sessionCreations = opened.sessionCreations
    this.emergencyStops = opened.emergencyStops

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
      if (!this.#restoreActiveProjects && stored && keepsSeveralProjects(stored.value)) {
        this.#database.close()
        this.#databaseClosed = true
        throw refuseSeveralProjects(path, stored.value)
      }
      try {
        const value = stored ? stored.value : JSON.parse(existing.snapshot) as unknown
        migratedExisting = migrateStoredWorkspace(
          this.#restoreActiveProjects && keepsSeveralProjects(value) ? restoreActiveWorkspace(value, this.#database) : value,
          { restoreActiveProjects: this.#restoreActiveProjects },
        )
      } catch (error) {
        if (error instanceof UnreadableActiveProjectStateError || (stored && keepsSeveralProjects(stored.value))) {
          this.#database.close()
          this.#databaseClosed = true
          throw error
        }
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
    const matchesMigratedSeed = existingSnapshot?.annotations.length === 0 &&
      options.legacySnapshots?.some(
        (snapshot) => legacyFingerprint(existingSnapshot) === legacyFingerprint(
          migrateStoredWorkspace(snapshot).snapshot,
        ),
      )
    // Effort aliases must not erase a person's change when identifying a seed.
    // Only possible seeds need another migration with effort repair disabled.
    const seedCandidate = matchesMigratedSeed && existing
      ? migrateStoredWorkspace(JSON.parse(existing.snapshot), { repairLegacyEffort: false }).snapshot
      : undefined
    const isLegacySeed = seedCandidate?.annotations.length === 0 &&
      options.legacySnapshots?.some(
        (snapshot) => legacyFingerprint(seedCandidate) === legacyFingerprint(
          migrateStoredWorkspace(snapshot, { repairLegacyEffort: false }).snapshot,
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
    else if (isLegacySeed) this.save(initial)
    else if (migratedExisting?.repaired) {
      this.save(migratedExisting.snapshot)
      this.#recordRuleInactivations(migratedExisting.inactivatedRules)
    }
    else if (existingSnapshot) this.#seedProjectRow(existingSnapshot)
    if (!recovery && !isLegacySeed && existingSnapshot) this.#migratedAtOpen = existingSnapshot
    this.#restrictFilePermissions()
  }

  load(): WorkspaceSnapshot {
    const migratedAtOpen = this.#migratedAtOpen
    this.#migratedAtOpen = undefined
    if (migratedAtOpen) return this.transferConflicts.restore(migratedAtOpen)
    const row = this.#database
      .prepare("SELECT snapshot FROM workspace_state WHERE id = 1")
      .get() as StoredWorkspace | undefined
    if (!row) throw new Error("Workspace state is not initialized")
    const value: unknown = JSON.parse(row.snapshot)
    if (!this.#restoreActiveProjects && keepsSeveralProjects(value)) throw refuseSeveralProjects(this.path, value)
    const migrated = migrateStoredWorkspace(
      this.#restoreActiveProjects && keepsSeveralProjects(value) ? restoreActiveWorkspace(value, this.#database) : value,
      { restoreActiveProjects: this.#restoreActiveProjects },
    )
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

  saveProjectClose(snapshot: WorkspaceSnapshot, closed: WorkspaceSnapshot): void {
    const validated = workspaceSnapshotSchema.parse(redactWorkspaceCopies(snapshot))
    const retained = workspaceSnapshotSchema.parse(redactWorkspaceCopies(closed))
    this.#writeValidated(validated, closedProjectRows(validated, retained))
  }

  async saveProjectCloseAsync(snapshot: WorkspaceSnapshot, closed: WorkspaceSnapshot): Promise<void> {
    this.#migratedAtOpen = undefined
    if (this.path === ":memory:") {
      this.saveProjectClose(snapshot, closed)
      return
    }
    if (this.#writer?.failed && !this.#writerClosed) this.#writer = undefined
    this.#writer ??= this.#writerFactory?.(this.path) ?? new AsyncWorkspaceWriter(this.path)
    if (!this.#writer.writeProjectClose) throw new Error("Workspace writer cannot atomically close a project")
    await this.#writer.writeProjectClose(redactWorkspaceCopies(snapshot), redactWorkspaceCopies(closed))
  }

  async saveAsync(snapshot: WorkspaceSnapshot): Promise<void> {
    this.#migratedAtOpen = undefined
    if (this.path === ":memory:") {
      await new Promise<void>((resolve) => setImmediate(resolve))
      this.#writeValidated(workspaceSnapshotSchema.parse(this.#redact(snapshot)))
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
        : this.#redact(snapshot),
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
      || !workspaceProjects(validated).some((project) => project.id === ownership.targetProjectId)
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
      rollBackIfOpen(this.#database)
      throw error
    }
    this.#restrictFilePermissions()
  }

  loadQueuedSessionSends(onUnreadable?: (unreadable: UnreadableQueuedSessionSend) => void): StoredQueuedSessionSend[] {
    const rows = this.#database.prepare(`
      SELECT rowid AS row_id, session_id, queue_id, state, payload
      FROM queued_session_sends
      ORDER BY created_at, queue_id
    `).all() as StoredQueuedSessionSendRowWithId[]
    const loaded: StoredQueuedSessionSend[] = []
    for (const row of rows) {
      try {
        loaded.push(parseStoredQueuedSessionSend(row))
      } catch (error) {
        // One row this build cannot read must not stop the daemon. Its bytes
        // move to a quarantine table with a receipt, and the rest still load.
        const described = {
          sessionId: String(row.session_id),
          queueId: String(row.queue_id),
          reason: describeFailure(error),
        }
        // Move the row aside whether or not the caller asked for a report.
        const quarantined = this.#quarantineQueuedSessionSend(row, described)
        onUnreadable?.({ ...described, quarantined })
      }
    }
    return loaded
  }

  #quarantineQueuedSessionSend(
    row: StoredQueuedSessionSendRowWithId,
    unreadable: Omit<UnreadableQueuedSessionSend, "quarantined">,
  ): boolean {
    const quarantinedAt = new Date().toISOString()
    let started = false
    try {
      this.#database.exec("BEGIN IMMEDIATE")
      started = true
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS queued_session_send_quarantine (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          queue_id TEXT,
          state TEXT,
          payload TEXT,
          reason TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        );
      `)
      this.#database.prepare(`
        INSERT INTO queued_session_send_quarantine (session_id, queue_id, state, payload, reason, quarantined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(row.session_id, row.queue_id, row.state, row.payload, unreadable.reason, quarantinedAt)
      // By rowid: a damaged row can hold a NULL session_id, which no equality
      // matches, and it would then be moved aside again on every load.
      const deleted = this.#database.prepare("DELETE FROM queued_session_sends WHERE rowid = ?").run(row.row_id)
      if (deleted.changes !== 1) throw new Error("The unreadable queued send was not removed")
      this.auditLog.append({
        occurredAt: quarantinedAt,
        actor: { kind: "daemon", component: "state-store" },
        action: "queued-send.quarantine",
        outcome: "succeeded",
        target: unreadable.queueId,
        detail: `A queued message for ${unreadable.sessionId} could not be read and was moved aside. ${unreadable.reason}`,
      })
      this.#database.exec("COMMIT")
      return true
    } catch {
      // A store that cannot move the row still skips it for this run; the
      // row stays where it is and the next start tries again. A lock that
      // refused the transaction leaves nothing to roll back.
      if (started) this.#rollBackIfOpen()
      return false
    }
  }

  // SQLite ends a transaction itself on some errors, such as a full
  // database; a ROLLBACK then fails with "no transaction is active".
  // isTransaction is absent before Node 22.16, so that error is tolerated there.
  #rollBackIfOpen(): void {
    const open = (this.#database as { isTransaction?: boolean }).isTransaction
    if (open === false) return
    try {
      this.#database.exec("ROLLBACK")
    } catch (error) {
      if (open === undefined && error instanceof Error && error.message.includes("no transaction is active")) return
      throw error
    }
  }

  replaceQueuedSessionSend(queued: StoredQueuedSessionSend): void {
    const reason = boundedQueuedSendReason(queued.reason)
    const metadata = queuedSessionSendSchema.parse({
      id: queued.id,
      sessionId: queued.sessionId,
      state: queued.state === "releasing" ? "unconfirmed" : queued.state,
      createdAt: queued.createdAt,
      origin: queued.origin,
      skillIds: queued.skillIds,
      attachments: queued.attachments,
      ...(reason ? { reason } : {}),
    })
    sessionSendParamsSchema.parse({
      sessionId: queued.sessionId,
      prompt: queued.prompt,
      client: queued.origin.client,
      ...(queued.skillSelection ? { skillSelection: queued.skillSelection } : {}),
      ...(queued.uploads ? { attachments: queued.uploads } : {}),
      ...(queued.review ? { review: queued.review } : {}),
      delivery: "next-turn-replace",
    })
    // The upsert below overwrites the session's row. If this build cannot read
    // that row, move its bytes aside first; if that fails, keep them.
    const existing = this.#database.prepare(`
      SELECT rowid AS row_id, session_id, queue_id, state, payload
      FROM queued_session_sends
      WHERE session_id = ?
    `).get(queued.sessionId) as StoredQueuedSessionSendRowWithId | undefined
    if (existing) {
      let failure: unknown
      try { parseStoredQueuedSessionSend(existing) } catch (error) { failure = error }
      if (failure !== undefined && !this.#quarantineQueuedSessionSend(existing, {
        sessionId: String(existing.session_id),
        queueId: String(existing.queue_id),
        reason: describeFailure(failure),
      })) {
        throw new Error("An unreadable queued message for this session could not be moved aside, so it was not replaced")
      }
    }
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
        ...(queued.review ? { review: queued.review } : {}),
        ...(queued.credentialDeviceId ? { credentialDeviceId: queued.credentialDeviceId } : {}),
        ...(reason ? { reason } : {}),
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
    const bounded = boundedQueuedSendReason(reason)
    if (bounded === undefined) delete payload.reason
    else payload.reason = bounded
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
      rollBackIfOpen(this.#database)
      throw error
    }
  }

  deleteQueuedSessionSend(sessionId: string, queueId: string): boolean {
    return this.#database.prepare(`
      DELETE FROM queued_session_sends WHERE session_id = ? AND queue_id = ?
    `).run(sessionId, queueId).changes === 1
  }

  loadProject(projectId: string, machine?: WorkspaceSnapshot["machine"]): ProjectWorkspaceState | undefined {
    const row = this.#database
      .prepare("SELECT state FROM workspace_projects WHERE project_id = ?")
      .get(projectId) as StoredProjectWorkspace | undefined
    if (!row) return undefined
    const stored = JSON.parse(row.state) as Record<string, unknown>
    if (!holdsOneProject(stored, projectId)) throw new SavedProjectStateError(projectId)
    const candidate = {
      ...stored,
      protocolVersion,
      machine: machine ?? this.load().machine,
      skillEnablements: [],
    } as unknown as WorkspaceSnapshot
    const snapshot = workspaceSnapshotSchema.parse(redactWorkspaceCopies(candidate))
    for (const session of snapshot.sessions) {
      session.runtime.reasoning = normalizeLegacyEffort(session.runtime.provider, session.runtime.reasoning)
    }
    return projectWorkspaceState(this.transferConflicts.restore(snapshot))
  }

  // Every saved project row, newest first, for project.list. Each row's
  // project and session list are read with SQLite's JSON functions, so a
  // project's thread is never parsed here. A row that does not read as one
  // project's own state is named in unreadable and left out.
  listProjects(sessionLimit: number): SavedProjectListing {
    // json_extract hands back a string scalar unquoted, so only an object
    // project and an array of sessions are taken as JSON text.
    const rows = this.#database.prepare(`
      SELECT project_id, updated_at,
        CASE WHEN json_valid(state) AND json_type(state, '$.project') = 'object'
          THEN json_extract(state, '$.project') END AS project,
        CASE WHEN json_valid(state) AND json_type(state, '$.sessions') = 'array'
          THEN json_extract(state, '$.sessions') END AS sessions
      FROM workspace_projects
      ORDER BY updated_at DESC, project_id
    `).all() as Array<{ project_id: string; updated_at: string; project: string | null; sessions: string | null }>
    const listing: SavedProjectListing = { projects: [], unreadable: [] }
    for (const row of rows) {
      let saved: SavedProject | undefined
      try {
        saved = savedProjectListing(row, sessionLimit)
      } catch {
        // One row that does not parse costs that row, never the list.
        saved = undefined
      }
      if (saved) listing.projects.push(saved)
      else listing.unreadable.push(row.project_id)
    }
    return listing
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

  #writeValidated(snapshot: WorkspaceSnapshot, closed: ProjectWorkspaceState[] = []): void {
    const updatedAt = new Date().toISOString()
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      this.#writeValidatedRows(snapshot, updatedAt, closed)
      this.#database.exec("COMMIT")
    } catch (error) {
      rollBackIfOpen(this.#database)
      throw error
    }
    this.#restrictFilePermissions()
  }

  #writeValidatedRows(snapshot: WorkspaceSnapshot, updatedAt: string, closed: ProjectWorkspaceState[] = []): void {
    this.#migratedAtOpen = undefined
    const rows = workspaceStorageRows(snapshot)
    rows.projects.push(...closed)
    this.#database
      .prepare(`
        INSERT INTO workspace_state (id, snapshot, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          snapshot = excluded.snapshot,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(rows.workspace), updatedAt)
    for (const state of rows.projects) {
      this.#database
        .prepare(`
          INSERT INTO workspace_projects (project_id, state, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET
            state = excluded.state,
            updated_at = excluded.updated_at
          WHERE workspace_projects.state <> excluded.state
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
