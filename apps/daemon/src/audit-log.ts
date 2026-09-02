import { randomUUID } from "node:crypto"
import type { DatabaseSync, StatementSync } from "node:sqlite"

import {
  auditEntrySchema,
  auditExportParamsSchema,
  auditExportResultSchema,
  auditQueryPageSchema,
  auditQueryParamsSchema,
  maximumAuditExportLength,
  type AuditActor,
  type AuditEntry,
  type AuditExportParams,
  type AuditExportResult,
  type AuditOutcome,
  type AuditQueryPage,
  type AuditQueryParams,
} from "@getdomovoi/protocol"

import { PublicRpcError, redactErrorDetail } from "./rpc-errors.js"

const defaultMaximumEntries = 10_000

export type AuditAppendInput = {
  id?: string
  occurredAt?: string
  actor: AuditActor
  action: string
  outcome: AuditOutcome
  sessionId?: string
  projectId?: string
  target?: string
  detail?: string
}

export interface AuditLog {
  append(input: AuditAppendInput): AuditEntry
  query(params?: Partial<AuditQueryParams>, signal?: AbortSignal): AuditQueryPage | Promise<AuditQueryPage>
  export(params?: Partial<AuditExportParams>, signal?: AbortSignal): AuditExportResult | Promise<AuditExportResult>
}

export type SqliteAuditLogOptions = {
  maximumEntries?: number
}

type StoredAuditEntry = {
  id: string
  occurred_at: string
  actor_kind: string
  actor_name: string | null
  actor_reference: string | null
  action: string
  outcome: string
  session_id: string | null
  project_id: string | null
  target: string | null
  detail: string | null
}

export class SqliteAuditLog implements AuditLog {
  #database: DatabaseSync
  #maximumEntries: number

  constructor(database: DatabaseSync, options: SqliteAuditLogOptions = {}) {
    this.#database = database
    this.#maximumEntries = validateMaximumEntries(options.maximumEntries ?? defaultMaximumEntries)
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_name TEXT,
        actor_reference TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        session_id TEXT,
        project_id TEXT,
        target TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_log_occurred_at ON audit_log (occurred_at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action);
      CREATE INDEX IF NOT EXISTS audit_log_session ON audit_log (session_id);
    `)
    const columns = this.#database.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>
    if (!columns.some(({ name }) => name === "project_id")) {
      this.#database.exec("ALTER TABLE audit_log ADD COLUMN project_id TEXT")
    }
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS audit_log_project ON audit_log (project_id);
    `)
  }

  append(input: AuditAppendInput): AuditEntry {
    const entry = auditEntrySchema.parse({
      id: sanitizeAuditText(input.id ?? `audit-${randomUUID()}`, 512),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      actor: sanitizeAuditActor(input.actor),
      action: sanitizeAuditText(input.action, 512),
      outcome: input.outcome,
      ...(input.sessionId === undefined
        ? {}
        : { sessionId: sanitizeAuditText(input.sessionId, 512) }),
      ...(input.projectId === undefined
        ? {}
        : { projectId: sanitizeAuditText(input.projectId, 512) }),
      ...(input.target === undefined ? {} : { target: sanitizeAuditText(input.target, 512) }),
      ...(input.detail === undefined ? {} : { detail: sanitizeAuditText(input.detail, 4_096) }),
    })

    this.#database.exec("BEGIN IMMEDIATE")
    try {
      this.#database.prepare(`
        INSERT INTO audit_log (
          id, occurred_at, actor_kind, actor_name, actor_reference,
          action, outcome, session_id, project_id, target, detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.occurredAt,
        entry.actor.kind,
        auditActorName(entry.actor),
        auditActorReference(entry.actor),
        entry.action,
        entry.outcome,
        entry.sessionId ?? null,
        entry.projectId ?? null,
        entry.target ?? null,
        entry.detail ?? null,
      )
      this.#database.prepare(`
        DELETE FROM audit_log
        WHERE sequence <= (SELECT MAX(sequence) - ? FROM audit_log)
      `).run(this.#maximumEntries)
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
    return entry
  }

  query(params: Partial<AuditQueryParams> = {}, signal?: AbortSignal): AuditQueryPage {
    signal?.throwIfAborted()
    const validated = auditQueryParamsSchema.parse(params)
    this.#assertCursor(validated.before)
    const { rows, hasMore } = this.#select(validated, validated.limit)
    const entries = rows.map(storedAuditEntry)
    const result = auditQueryPageSchema.parse({
      entries,
      hasMore,
      ...(hasMore ? { nextCursor: entries.at(-1)?.id } : {}),
    })
    signal?.throwIfAborted()
    return result
  }

  export(params: Partial<AuditExportParams> = {}, signal?: AbortSignal): AuditExportResult {
    signal?.throwIfAborted()
    const validated = auditExportParamsSchema.parse(params)
    this.#assertCursor(validated.before)
    const selection = this.#select(validated, validated.limit)
    const selectedEntries = selection.rows.map(storedAuditEntry)
    const entries: AuditEntry[] = []
    let content = ""
    for (const entry of selectedEntries) {
      const line = `${JSON.stringify(entry)}\n`
      if (content.length + line.length > maximumAuditExportLength) break
      entries.push(entry)
      content += line
    }
    const hasMore = selection.hasMore || entries.length < selectedEntries.length
    const result = auditExportResultSchema.parse({
      format: validated.format,
      exportedAt: entries[0]?.occurredAt ?? "1970-01-01T00:00:00.000Z",
      entryCount: entries.length,
      content,
      hasMore,
      ...(hasMore ? { nextCursor: entries.at(-1)?.id } : {}),
    })
    signal?.throwIfAborted()
    return result
  }

  #select(
    filters: Partial<AuditQueryParams>,
    limit: number,
  ): { rows: StoredAuditEntry[]; hasMore: boolean } {
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (filters.before) {
      conditions.push("sequence < (SELECT sequence FROM audit_log WHERE id = ?)")
      values.push(filters.before)
    }
    if (filters.action) {
      conditions.push("action = ?")
      values.push(filters.action)
    }
    if (filters.actor) {
      conditions.push("(actor_kind = ? OR actor_name = ? OR actor_reference = ?)")
      values.push(filters.actor, filters.actor, filters.actor)
    }
    if (filters.outcome) {
      conditions.push("outcome = ?")
      values.push(filters.outcome)
    }
    if (filters.sessionId) {
      conditions.push("session_id = ?")
      values.push(filters.sessionId)
    }
    if (filters.projectId) {
      conditions.push("project_id = ?")
      values.push(filters.projectId)
    }
    if (filters.query) {
      const query = `%${escapeLike(filters.query)}%`
      conditions.push(`(
        action LIKE ? ESCAPE '\\'
        OR actor_kind LIKE ? ESCAPE '\\'
        OR COALESCE(actor_name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(actor_reference, '') LIKE ? ESCAPE '\\'
        OR COALESCE(session_id, '') LIKE ? ESCAPE '\\'
        OR COALESCE(project_id, '') LIKE ? ESCAPE '\\'
        OR COALESCE(target, '') LIKE ? ESCAPE '\\'
        OR COALESCE(detail, '') LIKE ? ESCAPE '\\'
      )`)
      values.push(query, query, query, query, query, query, query, query)
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
    const statement = this.#database.prepare(`
      SELECT id, occurred_at, actor_kind, actor_name, actor_reference,
        action, outcome, session_id, project_id, target, detail
      FROM audit_log
      ${where}
      ORDER BY sequence DESC
      LIMIT ?
    `)
    const rows = allAuditRows(statement, [...values, limit + 1])
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
  }

  #assertCursor(cursor: string | undefined): void {
    if (!cursor) return
    const row = this.#database.prepare("SELECT 1 FROM audit_log WHERE id = ?").get(cursor)
    if (!row) throw new PublicRpcError(-32602, "Audit cursor does not exist")
  }
}

function allAuditRows(statement: StatementSync, values: Array<string | number>): StoredAuditEntry[] {
  return statement.all(...values) as unknown as StoredAuditEntry[]
}

function storedAuditEntry(row: StoredAuditEntry): AuditEntry {
  return auditEntrySchema.parse({
    id: row.id,
    occurredAt: row.occurred_at,
    actor: storedAuditActor(row),
    action: row.action,
    outcome: row.outcome,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.target === null ? {} : { target: row.target }),
    ...(row.detail === null ? {} : { detail: row.detail }),
  })
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&")
}

function sanitizeAuditText(value: string, maximumLength: number): string {
  return redactErrorDetail(value).slice(0, maximumLength)
}

function sanitizeAuditActor(actor: AuditActor): AuditActor {
  switch (actor.kind) {
    case "client":
      return {
        kind: actor.kind,
        client: actor.client,
        ...(actor.clientId === undefined
          ? {}
          : { clientId: sanitizeAuditText(actor.clientId, 128) }),
      }
    case "provider":
      return {
        kind: actor.kind,
        provider: sanitizeAuditText(actor.provider, 128),
        ...(actor.providerThreadId === undefined
          ? {}
          : { providerThreadId: sanitizeAuditText(actor.providerThreadId, 128) }),
      }
    case "daemon":
      return {
        kind: actor.kind,
        ...(actor.component === undefined
          ? {}
          : { component: sanitizeAuditText(actor.component, 128) }),
      }
  }
}

function auditActorName(actor: AuditActor): string | null {
  switch (actor.kind) {
    case "client": return actor.client
    case "provider": return actor.provider
    case "daemon": return actor.component ?? null
  }
}

function auditActorReference(actor: AuditActor): string | null {
  switch (actor.kind) {
    case "client": return actor.clientId ?? null
    case "provider": return actor.providerThreadId ?? null
    case "daemon": return null
  }
}

function storedAuditActor(row: StoredAuditEntry): unknown {
  switch (row.actor_kind) {
    case "client":
      return {
        kind: row.actor_kind,
        client: row.actor_name,
        ...(row.actor_reference === null ? {} : { clientId: row.actor_reference }),
      }
    case "provider":
      return {
        kind: row.actor_kind,
        provider: row.actor_name,
        ...(row.actor_reference === null ? {} : { providerThreadId: row.actor_reference }),
      }
    case "daemon":
      return {
        kind: row.actor_kind,
        ...(row.actor_name === null ? {} : { component: row.actor_name }),
      }
    default:
      return { kind: row.actor_kind }
  }
}

function validateMaximumEntries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new RangeError("Audit retention must be between 1 and 100000 entries")
  }
  return value
}
