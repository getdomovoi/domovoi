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
// stop is finished with a line per client it names, so one without a
// readable client is finished without its line.
export type RecoveredEmergencyStopIntent = {
  stopId: string
  clients: Array<EmergencyStopIntent["client"]>
  requestedAt: string
  sessionIds: string[]
  inFlight: Array<{ sessionId: string; provider?: string; providerThreadId?: string }>
}

type InFlight = RecoveredEmergencyStopIntent["inFlight"][number]
const inFlightEntry = ({ sessionId, provider, providerThreadId }: { sessionId: string; provider?: string | undefined; providerThreadId?: string | undefined }): InFlight =>
  provider === undefined || providerThreadId === undefined ? { sessionId } : { sessionId, provider, providerThreadId }

// The most sessions, and the most in-flight entries, one stop keeps, as the
// stop itself writes them.
const maximumEntries = 10_000

type Read =
  | { intents: RecoveredEmergencyStopIntent[]; partial?: string; overflow?: string }
  | { unreadable: string }

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_024)

// A JSON object with every value of a repeated key kept, in order.
type Fields = { readonly fields: Map<string, unknown[]> }
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && "fields" in value
  && (value as Fields).fields instanceof Map
const skippedValue = Symbol("skipped")

// Round 5 of #628: JSON.parse keeps only the last value of a repeated key, so
// a later field could replace a readable one. This reads text JSON.parse has
// already accepted, down to the depth the stop's fields reach (the row, its
// lists, an in-flight entry), keeping every value of each key. Containers
// deeper than that are skipped whole, without recursion.
function readFields(text: string): unknown {
  let at = 0
  const space = () => { while (at < text.length && " \t\n\r".includes(text[at]!)) at += 1 }
  const stringEnd = (from: number) => {
    let index = from + 1
    while (text[index] !== "\"") index += text[index] === "\\" ? 2 : 1
    return index + 1
  }
  const primitiveEnd = (from: number) => {
    let index = from
    while (index < text.length && !",}] \t\n\r".includes(text[index]!)) index += 1
    return index
  }
  const skipContainer = () => {
    let depth = 0
    do {
      const character = text[at]!
      if (character === "\"") { at = stringEnd(at); continue }
      if (character === "{" || character === "[") depth += 1
      else if (character === "}" || character === "]") depth -= 1
      at += 1
    } while (depth > 0)
  }
  const value = (depth: number): unknown => {
    space()
    const character = text[at]
    if (character === "{" || character === "[") {
      if (depth > 2) { skipContainer(); return skippedValue }
      at += 1
      const fields = new Map<string, unknown[]>()
      const items: unknown[] = []
      const close = character === "{" ? "}" : "]"
      space()
      if (text[at] === close) { at += 1; return character === "{" ? { fields } : items }
      for (;;) {
        space()
        if (character === "{") {
          const end = stringEnd(at)
          const key = z.string().parse(JSON.parse(text.slice(at, end)) as unknown)
          at = end
          space()
          at += 1
          const item = value(depth + 1)
          const values = fields.get(key)
          if (values) values.push(item)
          else fields.set(key, [item])
        } else {
          items.push(value(depth + 1))
        }
        space()
        if (text[at] === ",") { at += 1; continue }
        at += 1
        return character === "{" ? { fields } : items
      }
    }
    const start = at
    at = character === "\"" ? stringEnd(at) : primitiveEnd(at)
    return JSON.parse(text.slice(start, at)) as unknown
  }
  return value(0)
}

// Round 4 of #628: a row reaches quarantine only when no stop can be read
// from it, that is, when it is not a JSON object or no stop id can be read
// from its record or its key. Anything else is a stop: its known fields are
// read one by one, and whatever does not read (an unknown field, a bad
// entry, a repeated field) is reported as partial. Round 5: every value of a
// repeated field counts (each stop id is finished, the sessions of every
// list are joined), and every entry of a list is read, however many before
// it do not; past the kept number of readable entries the row is overflow.
function readIntent(key: SQLInputValue, record: SQLInputValue): Read {
  if (typeof record !== "string") return { unreadable: "The record is not text" }
  let plain: unknown
  try {
    plain = JSON.parse(record)
  } catch (error) {
    return { unreadable: reason(error) }
  }
  if (typeof plain !== "object" || plain === null || Array.isArray(plain)) return { unreadable: "The record is not an object" }
  const read = readFields(record)
  if (!isFields(read)) return { unreadable: "The record is not an object" }
  const repeated = (fields: Fields) => [...fields.fields.values()].some((values) => values.length > 1)
  const all = (fields: Fields, name: string) => fields.fields.get(name) ?? []
  const valid = <T>(schema: z.ZodType<T>, values: unknown[]) => [...new Set(values.flatMap((entry) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  }))]
  const entries = all(read, "inFlight").flatMap((list) => Array.isArray(list) ? list : []).filter(isFields)
  const anyRepeated = repeated(read) || entries.some(repeated)

  const strict = anyRepeated ? undefined : intentSchema.safeParse(plain)
  if (strict?.success) {
    const { client, requestedAt, sessionIds, inFlight, stopId } = strict.data
    return { intents: [{ stopId, clients: [client], requestedAt, sessionIds, inFlight: (inFlight ?? []).map(inFlightEntry) }] }
  }
  const named = valid(stopIdSchema, all(read, "stopId"))
  const stopIds = named.length > 0 ? named : valid(stopIdSchema, [key])
  if (stopIds.length === 0) return { unreadable: "No stop id can be read from the record or its key" }

  const sessionIds = valid(sessionIdSchema, all(read, "sessionIds").flatMap((list) => Array.isArray(list) ? list : []))
  const inFlight = entries.flatMap((entry) => {
    const providers = valid(inFlightFields.provider.unwrap(), all(entry, "provider"))
    const threads = valid(inFlightFields.providerThreadId.unwrap(), all(entry, "providerThreadId"))
    return valid(sessionIdSchema, all(entry, "sessionId")).flatMap((sessionId) => providers.length === 0 || threads.length === 0
      ? [{ sessionId }]
      : providers.flatMap((provider) => threads.map((providerThreadId) => ({ sessionId, provider, providerThreadId }))))
  })
  const overflow = sessionIds.length > maximumEntries || inFlight.length > maximumEntries
    ? `The record names ${sessionIds.length} sessions and ${inFlight.length} dispatches; ${maximumEntries} of each are kept`
    : undefined
  const recovered = {
    clients: valid(clientKindSchema, all(read, "client")),
    requestedAt: valid(dateTimeSchema, all(read, "requestedAt"))[0] ?? new Date().toISOString(),
    sessionIds: sessionIds.slice(0, maximumEntries),
    inFlight: inFlight.slice(0, maximumEntries),
  }
  return {
    intents: stopIds.map((stopId) => ({ stopId, ...recovered })),
    partial: anyRepeated ? "The record repeats a field" : reason(strict?.error),
    ...(overflow === undefined ? {} : { overflow }),
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
  // a stop, and is finished from its record. A row with more readable entries
  // than a stop keeps is finished as far as it goes, returned as overflow
  // each time, and marked `keep`: it is never cleared.
  pending(): {
    intents: Array<{ key: SQLInputValue; intent: RecoveredEmergencyStopIntent; keep: boolean }>
    partial: Array<{ key: string; reason: string }>
    overflow: Array<{ key: string; reason: string }>
    setAside: Array<{ key: string; reason: string }>
  } {
    const rows = this.#database.prepare("SELECT stop_id, record FROM emergency_stop_intents ORDER BY rowid")
      .all() as Array<{ stop_id: SQLInputValue; record: SQLInputValue }>
    const intents: Array<{ key: SQLInputValue; intent: RecoveredEmergencyStopIntent; keep: boolean }> = []
    const partial: Array<{ key: string; reason: string }> = []
    const overflow: Array<{ key: string; reason: string }> = []
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
      if (read.overflow !== undefined) overflow.push({ key: String(row.stop_id), reason: read.overflow })
      for (const intent of read.intents) intents.push({ key: row.stop_id, intent, keep: read.overflow !== undefined })
    }
    return { intents, partial, overflow, setAside }
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
