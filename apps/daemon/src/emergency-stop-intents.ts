import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { clientKindSchema, dateTimeSchema } from "@getdomovoi/protocol"
import { z } from "zod"

export const maximumEmergencyStopIntentBytes = 1024 * 1024

const intentSchema = z.object({
  version: z.literal(1),
  stopId: z.string().regex(/^stop-[0-9a-f-]{36}$/),
  client: clientKindSchema,
  requestedAt: dateTimeSchema,
  sessionIds: z.array(z.string().min(1).max(1_024)).max(10_000),
  // Dispatches the stop caught in flight, by the provider thread each was
  // sent to. A completed stop resets those threads; a restart does the same.
  inFlight: z.array(z.object({
    sessionId: z.string().min(1).max(1_024),
    provider: z.string().min(1).max(1_024),
    providerThreadId: z.string().min(1).max(4_096),
  }).strict()).max(10_000).optional(),
}).strict()

export type EmergencyStopIntent = z.infer<typeof intentSchema>

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

  // Oldest first, each with the key it is stored under. A row whose record
  // does not read back cannot be finished and must not keep the daemon from
  // starting: it moves, whole, to emergency_stop_intent_quarantine with the
  // reason, and is returned as set aside, once. A row whose key disagrees with
  // its record is still a stop, and is finished from its record.
  pending(): { intents: Array<{ key: SQLInputValue; intent: EmergencyStopIntent }>; setAside: Array<{ key: string; reason: string }> } {
    const rows = this.#database.prepare("SELECT stop_id, record FROM emergency_stop_intents ORDER BY rowid")
      .all() as Array<{ stop_id: SQLInputValue; record: SQLInputValue }>
    const intents: Array<{ key: SQLInputValue; intent: EmergencyStopIntent }> = []
    const setAside: Array<{ key: string; reason: string }> = []
    for (const row of rows) {
      let intent: EmergencyStopIntent
      try {
        if (typeof row.record !== "string") throw new Error("The record is not text")
        intent = intentSchema.parse(JSON.parse(row.record))
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1_024)
        this.#setAside(row.stop_id, row.record, reason)
        setAside.push({ key: String(row.stop_id), reason })
        continue
      }
      intents.push({ key: row.stop_id, intent })
    }
    return { intents, setAside }
  }

  clear(key: SQLInputValue): void {
    this.#database.prepare("DELETE FROM emergency_stop_intents WHERE stop_id IS ?").run(key)
  }

  #setAside(key: SQLInputValue, record: SQLInputValue, reason: string): void {
    this.#database.exec(`CREATE TABLE IF NOT EXISTS emergency_stop_intent_quarantine (
      stop_id, record, reason TEXT NOT NULL, set_aside_at TEXT NOT NULL
    )`)
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      this.#database.prepare("INSERT INTO emergency_stop_intent_quarantine (stop_id, record, reason, set_aside_at) VALUES (?, ?, ?, ?)")
        .run(key, record, reason, new Date().toISOString())
      this.#database.prepare("DELETE FROM emergency_stop_intents WHERE stop_id IS ?").run(key)
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }
}
