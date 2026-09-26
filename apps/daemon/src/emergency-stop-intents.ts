import type { DatabaseSync } from "node:sqlite"
import { clientKindSchema, dateTimeSchema } from "@getdomovoi/protocol"
import { z } from "zod"

export const maximumEmergencyStopIntentBytes = 1024 * 1024

const intentSchema = z.object({
  version: z.literal(1),
  stopId: z.string().regex(/^stop-[0-9a-f-]{36}$/),
  client: clientKindSchema,
  requestedAt: dateTimeSchema,
  sessionIds: z.array(z.string().min(1).max(1_024)).max(10_000),
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

  // Oldest first. A row that does not read back throws: a stop's record is
  // not dropped because it cannot be read.
  pending(): EmergencyStopIntent[] {
    const rows = this.#database.prepare("SELECT stop_id, record FROM emergency_stop_intents ORDER BY rowid")
      .all() as Array<{ stop_id: string; record: string }>
    return rows.map((row) => {
      const intent = intentSchema.parse(JSON.parse(row.record))
      if (intent.stopId !== row.stop_id) throw new Error("Stored emergency stop intent has conflicting identity")
      return intent
    })
  }

  clear(stopId: string): void {
    this.#database.prepare("DELETE FROM emergency_stop_intents WHERE stop_id = ?").run(stopId)
  }
}
