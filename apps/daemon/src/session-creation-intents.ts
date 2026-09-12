import type { DatabaseSync } from "node:sqlite"
import { sessionSummarySchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { z } from "zod"
import { redactDurableText } from "./secret-redaction.js"
import type { SessionWorkspace } from "./workspace.js"

export const maximumPendingSessionCreations = 1_024
export const maximumSessionCreationIntentBytes = 64 * 1_024
export class SessionCreationRefusalError extends Error {
  constructor(message: string) { super(message); this.name = "SessionCreationRefusalError" }
}
const pathSchema = z.string().min(1).max(32_768)
const intentSchema = z.object({
  version: z.literal(1),
  ownerPid: z.number().int().min(1).max(2_147_483_647),
  cleanupStarted: z.boolean(),
  session: sessionSummarySchema,
  repositoryPath: pathSchema,
  expectedWorkspacePath: pathSchema.optional(),
  workspace: z.object({ path: pathSchema, branch: z.string().min(1).max(1_024), baseCommit: z.string().regex(/^[a-f0-9]{40}$/) }).optional(),
}).strict().refine(({ session }) => session.state === "failed" && !session.workspacePath
  && !session.providerThreadId && !session.activeTurnId, "Creation intent must not publish a usable session")

export type SessionCreationIntent = z.infer<typeof intentSchema>
type NewIntent = Pick<SessionCreationIntent, "session" | "repositoryPath" | "expectedWorkspacePath">
type StoredIntent = { session_id: string; project_id: string; record: string }

function encode(intent: SessionCreationIntent): string {
  const record = JSON.stringify(intentSchema.parse(intent))
  if (Buffer.byteLength(record, "utf8") > maximumSessionCreationIntentBytes) throw new Error("Session creation intent exceeds its byte budget")
  return record
}

function decode(row: StoredIntent): SessionCreationIntent {
  if (Buffer.byteLength(row.record, "utf8") > maximumSessionCreationIntentBytes) throw new Error("Stored session creation intent exceeds its byte budget")
  const intent = intentSchema.parse(JSON.parse(row.record))
  if (intent.session.id !== row.session_id || intent.session.projectId !== row.project_id) {
    throw new Error("Stored session creation intent has conflicting identity")
  }
  return intent
}

/** A completion receipt is written only after the guarded Git operation settles. */
export class SqliteSessionCreationIntents {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    database.exec(`CREATE TABLE IF NOT EXISTS session_creation_intents (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= ${maximumSessionCreationIntentBytes})
    );
    CREATE INDEX IF NOT EXISTS session_creation_intents_project ON session_creation_intents(project_id)`)
  }

  begin(input: NewIntent): void {
    const record = encode({ ...input, version: 1, ownerPid: process.pid, cleanupStarted: false,
      session: { ...input.session, title: redactDurableText(input.session.title).value } })
    const inserted = this.#database.prepare(`INSERT INTO session_creation_intents (session_id, project_id, record)
      SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM session_creation_intents) < ?
      ON CONFLICT(session_id) DO NOTHING`)
      .run(input.session.id, input.session.projectId, record, maximumPendingSessionCreations)
    if (inserted.changes !== 1) {
      if (this.#database.prepare("SELECT 1 FROM session_creation_intents WHERE session_id = ?").get(input.session.id)) {
        throw new SessionCreationRefusalError("Session creation is already pending; preserve its worktree until setup or cleanup is resolved")
      }
      throw new SessionCreationRefusalError("Pending session creation budget is full; resolve interrupted setup before creating another session")
    }
  }

  complete(sessionId: string, workspace: SessionWorkspace): void {
    const row = this.#database.prepare("SELECT session_id, project_id, record FROM session_creation_intents WHERE session_id = ?")
      .get(sessionId) as StoredIntent | undefined
    if (!row) throw new Error("Session creation intent disappeared before completion")
    const intent = decode(row)
    if (intent.ownerPid !== process.pid) throw new Error("Session creation intent belongs to another process")
    if (intent.cleanupStarted) throw new Error("Session creation cleanup already started")
    const updated = this.#database.prepare("UPDATE session_creation_intents SET record = ? WHERE session_id = ? AND record = ?")
      .run(encode({ ...intent, workspace }), sessionId, row.record)
    if (updated.changes !== 1) throw new Error("Session creation intent changed while recording completion")
  }

  pending(projectId: string): SessionCreationIntent[] {
    const rows = this.#database.prepare("SELECT session_id, project_id, record FROM session_creation_intents WHERE project_id = ? ORDER BY rowid LIMIT ?")
      .all(projectId, maximumPendingSessionCreations + 1) as StoredIntent[]
    if (rows.length > maximumPendingSessionCreations) throw new Error("Stored session creation intents exceed their count budget")
    return rows.map(decode)
  }

  /** Invalidate the receipt's usable-worktree claim before removal can start. */
  beginCleanup(sessionId: string): void {
    const row = this.#database.prepare("SELECT session_id, project_id, record FROM session_creation_intents WHERE session_id = ?")
      .get(sessionId) as StoredIntent | undefined
    if (!row) throw new Error("Session creation intent disappeared before cleanup")
    const intent = decode(row)
    if (intent.ownerPid !== process.pid) throw new Error("Session creation intent belongs to another process")
    if (intent.cleanupStarted) throw new Error("Session creation cleanup already started")
    const updated = this.#database.prepare("UPDATE session_creation_intents SET record = ? WHERE session_id = ? AND record = ?")
      .run(encode({ ...intent, cleanupStarted: true }), sessionId, row.record)
    if (updated.changes !== 1) throw new Error("Session creation intent changed before cleanup")
  }

  /** Caller must await successful worktree removal before discarding evidence. */
  discardAfterCleanup(sessionId: string): void {
    const row = this.#database.prepare("SELECT session_id, project_id, record FROM session_creation_intents WHERE session_id = ?")
      .get(sessionId) as StoredIntent | undefined
    if (!row) return
    const intent = decode(row)
    if (intent.ownerPid !== process.pid) throw new Error("Session creation intent belongs to another process")
    if (!intent.cleanupStarted) throw new Error("Session creation cleanup was not recorded")
    const removed = this.#database.prepare("DELETE FROM session_creation_intents WHERE session_id = ? AND record = ?")
      .run(sessionId, row.record)
    if (removed.changes !== 1) throw new Error("Session creation intent changed during cleanup")
  }

  clearCommitted(sessions: WorkspaceSnapshot["sessions"]): void {
    const ids = new Set(sessions.map(({ id }) => id))
    const pending = this.#database.prepare("SELECT session_id FROM session_creation_intents").all() as Array<{ session_id: string }>
    const remove = this.#database.prepare("DELETE FROM session_creation_intents WHERE session_id = ?")
    for (const { session_id } of pending) if (ids.has(session_id)) remove.run(session_id)
  }
}
