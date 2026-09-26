import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { clientKindSchema, dateTimeSchema } from "@getdomovoi/protocol"
import { z } from "zod"

export const maximumEmergencyStopIntentBytes = 1024 * 1024

const stopIdSchema = z.string().regex(/^stop-[0-9a-f-]{36}$/)
const sessionIdSchema = z.string().min(1).max(1_024)
// A dispatch the stop caught in flight. The provider and thread id, whole,
// name the thread a completed stop resets; without them the stop only marks
// the session failed.
const inFlightFields = {
  sessionId: sessionIdSchema,
  provider: z.string().min(1).max(1_024).optional(),
  providerThreadId: z.string().min(1).max(4_096).optional(),
}
const bothOrNeither = (entry: { provider?: string | undefined; providerThreadId?: string | undefined }) =>
  (entry.provider === undefined) === (entry.providerThreadId === undefined)

// What the stop writes: exactly these fields.
const intentSchema = z.object({
  version: z.literal(1),
  stopId: stopIdSchema,
  client: clientKindSchema,
  requestedAt: dateTimeSchema,
  sessionIds: z.array(sessionIdSchema).max(10_000),
  inFlight: z.array(z.object(inFlightFields).strict().refine(bothOrNeither)).max(10_000).optional(),
}).strict()

export type EmergencyStopIntent = z.infer<typeof intentSchema>

// What a restart finishes: the stop's fields as far as they can be read. A
// stop without a readable client is finished without its line.
export type RecoveredEmergencyStopIntent = {
  stopId: string
  client?: EmergencyStopIntent["client"]
  requestedAt: string
  sessionIds: string[]
  inFlight: Array<{ sessionId: string; provider?: string; providerThreadId?: string }>
}

type InFlight = RecoveredEmergencyStopIntent["inFlight"][number]
const inFlightEntry = ({ sessionId, provider, providerThreadId }: { sessionId: string; provider?: string | undefined; providerThreadId?: string | undefined }): InFlight =>
  provider === undefined || providerThreadId === undefined ? { sessionId } : { sessionId, provider, providerThreadId }

type Read = { intent: RecoveredEmergencyStopIntent; partial?: string } | { unreadable: string }

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_024)

// Round 4 of #628: a row reaches quarantine only when no stop can be read
// from it, that is, when it is not a JSON object or no stop id can be read
// from its record or its key. Anything else is a stop: its known fields are
// read one by one, and whatever does not read (an unknown field, a bad
// entry) is reported as partial.
function readIntent(key: SQLInputValue, record: SQLInputValue): Read {
  if (typeof record !== "string") return { unreadable: "The record is not text" }
  let value: unknown
  try {
    value = JSON.parse(record)
  } catch (error) {
    return { unreadable: reason(error) }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { unreadable: "The record is not an object" }
  const strict = intentSchema.safeParse(value)
  if (strict.success) {
    const { client, requestedAt, sessionIds, inFlight, stopId } = strict.data
    return { intent: { stopId, client, requestedAt, sessionIds, inFlight: (inFlight ?? []).map(inFlightEntry) } }
  }
  const fields = value as Record<string, unknown>
  const stopId = stopIdSchema.safeParse(fields.stopId).data ?? stopIdSchema.safeParse(key).data
  if (stopId === undefined) return { unreadable: "No stop id can be read from the record or its key" }
  const client = clientKindSchema.safeParse(fields.client).data
  const listed = (field: unknown) => Array.isArray(field) ? field.slice(0, 10_000) : []
  return {
    intent: {
      stopId,
      ...(client === undefined ? {} : { client }),
      requestedAt: dateTimeSchema.safeParse(fields.requestedAt).data ?? new Date().toISOString(),
      sessionIds: listed(fields.sessionIds).flatMap((entry) => {
        const parsed = sessionIdSchema.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      }),
      inFlight: listed(fields.inFlight).flatMap((entry) => {
        const parsed = z.object(inFlightFields).refine(bothOrNeither).safeParse(entry)
        return parsed.success ? [inFlightEntry(parsed.data)] : []
      }),
    },
    partial: reason(strict.error),
  }
}

// Security review round 2 of #628: an emergency stop acts on providers,
// terminals and gates before it saves its record, and the process can end in
// between (a crash, a kill, the desktop's quit bound). The stop writes this
// intent before its first effect and clears it once its save lands, so a
// restart on the same store knows a stop was cut off and finishes it.
export class SqliteEmergencyStopIntents {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    database.exec(`CREATE TABLE IF NOT EXISTS emergency_stop_intents (
      stop_id TEXT PRIMARY KEY,
      record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= ${maximumEmergencyStopIntentBytes})
    )`)
  }

  begin(intent: EmergencyStopIntent): void {
    const record = JSON.stringify(intentSchema.parse(intent))
    if (Buffer.byteLength(record, "utf8") > maximumEmergencyStopIntentBytes) throw new Error("Emergency stop intent exceeds its byte budget")
    this.#database.prepare("INSERT INTO emergency_stop_intents (stop_id, record) VALUES (?, ?)").run(intent.stopId, record)
  }

  // Oldest first, each with the key it is stored under. A row from which no
  // stop can be read must not keep the daemon from starting: it moves, whole,
  // to emergency_stop_intent_quarantine with the reason, and is returned as
  // set aside, once. A row read only in part is still finished from what it
  // holds; a copy of it, as stored, goes to the quarantine table once, and it
  // is returned as partial. A row whose key disagrees with its record is still
  // a stop, and is finished from its record.
  pending(): {
    intents: Array<{ key: SQLInputValue; intent: RecoveredEmergencyStopIntent }>
    partial: Array<{ key: string; reason: string }>
    setAside: Array<{ key: string; reason: string }>
  } {
    const rows = this.#database.prepare("SELECT stop_id, record FROM emergency_stop_intents ORDER BY rowid")
      .all() as Array<{ stop_id: SQLInputValue; record: SQLInputValue }>
    const intents: Array<{ key: SQLInputValue; intent: RecoveredEmergencyStopIntent }> = []
    const partial: Array<{ key: string; reason: string }> = []
    const setAside: Array<{ key: string; reason: string }> = []
    for (const row of rows) {
      const read = readIntent(row.stop_id, row.record)
      if ("unreadable" in read) {
        this.#quarantine(row.stop_id, row.record, read.unreadable, true)
        setAside.push({ key: String(row.stop_id), reason: read.unreadable })
        continue
      }
      if (read.partial !== undefined && this.#quarantine(row.stop_id, row.record, read.partial, false)) {
        partial.push({ key: String(row.stop_id), reason: read.partial })
      }
      intents.push({ key: row.stop_id, intent: read.intent })
    }
    return { intents, partial, setAside }
  }

  clear(key: SQLInputValue): void {
    this.#database.prepare("DELETE FROM emergency_stop_intents WHERE stop_id IS ?").run(key)
  }

  // Copies the row as stored to the quarantine table, and moves it there
  // when `move`. A copy already there is not made twice. Answers whether
  // this call made it.
  #quarantine(key: SQLInputValue, record: SQLInputValue, why: string, move: boolean): boolean {
    this.#database.exec(`CREATE TABLE IF NOT EXISTS emergency_stop_intent_quarantine (
      stop_id, record, reason TEXT NOT NULL, set_aside_at TEXT NOT NULL
    )`)
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const copied = this.#database.prepare("SELECT 1 FROM emergency_stop_intent_quarantine WHERE stop_id IS ? AND record IS ?")
        .get(key, record) !== undefined
      if (!copied) {
        this.#database.prepare("INSERT INTO emergency_stop_intent_quarantine (stop_id, record, reason, set_aside_at) VALUES (?, ?, ?, ?)")
          .run(key, record, why, new Date().toISOString())
      }
      if (move) this.#database.prepare("DELETE FROM emergency_stop_intents WHERE stop_id IS ?").run(key)
      this.#database.exec("COMMIT")
      return !copied
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }
}
