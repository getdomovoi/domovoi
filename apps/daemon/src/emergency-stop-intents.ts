import { createHash } from "node:crypto"
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
// The most work one row asks of a restart: a line per client and session and
// a reset per dispatch, for each stop id it names, and at least one unit per
// stop id. A row in the stop's own format asks at most this much.
const maximumWork = 2 * maximumEntries
// Issue #632: the most journal rows one pass reads. Each row is at most
// `maximumEmergencyStopIntentBytes` and asks at most `maximumWork`, so a pass
// holds a bounded number of rows and stops, however long the journal is.
export const emergencyStopRowsPerPass = 16
// Security review round 2 of #641: the most rounds over the journal one start
// makes. A round reads the rows no round has read yet, and a trigger in the
// store can put a new row in place of each one a round clears, without end.
// Past this many rounds startup fails, and the next start continues.
export const emergencyStopRecoveryRounds = 16

type Read =
  | { intents: RecoveredEmergencyStopIntent[]; partial?: string; overflow?: string }
  | { unreadable: string }

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_024)

// Security review round 2 of #641: a row is known by its key and record as
// stored, not by its rowid alone, since a new row can take the rowid of one
// recovery cleared. A digest stands in for them, so recovery keeps a fixed
// size per row it has read, not a second copy of the row.
function rowIdentity(key: SQLInputValue, record: SQLInputValue): string {
  const digest = createHash("sha256")
  for (const value of [key, record]) {
    const kind = value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value
    const bytes = value instanceof Uint8Array ? value : Buffer.from(value === null ? "" : String(value), "utf8")
    digest.update(`${kind}:${bytes.length}:`).update(bytes)
  }
  return digest.digest("hex")
}

type JournalRow = { row: bigint; stop_id: SQLInputValue; record: SQLInputValue }

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
// `built` is told of each dispatch entry as it is made, so a test can count them.
function readIntent(key: SQLInputValue, record: SQLInputValue, built: () => void = () => {}): Read {
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
    return { intents: [{ stopId, clients: [client], requestedAt, sessionIds: [...new Set(sessionIds)], inFlight: (inFlight ?? []).map(inFlightEntry) }] }
  }
  const named = valid(stopIdSchema, all(read, "stopId"))
  const stopIds = named.length > 0 ? named : valid(stopIdSchema, [key])
  if (stopIds.length === 0) return { unreadable: "No stop id can be read from the record or its key" }

  // Round 6: each value a row repeats multiplies what it names. Every list is
  // counted as it is built and stops one past the kept number, so nothing is
  // built past it, and the work the kept stop ids ask is bounded too.
  const sessionIds = valid(sessionIdSchema, all(read, "sessionIds").flatMap((list) => Array.isArray(list) ? list : []))
  const inFlight: InFlight[] = []
  const add = (dispatch: InFlight) => { built(); inFlight.push(dispatch) }
  fill: for (const entry of entries) {
    const providers = valid(inFlightFields.provider.unwrap(), all(entry, "provider"))
    const threads = valid(inFlightFields.providerThreadId.unwrap(), all(entry, "providerThreadId"))
    for (const sessionId of valid(sessionIdSchema, all(entry, "sessionId"))) {
      if (providers.length === 0 || threads.length === 0) {
        add({ sessionId })
        if (inFlight.length > maximumEntries) break fill
        continue
      }
      for (const provider of providers) {
        for (const providerThreadId of threads) {
          add({ sessionId, provider, providerThreadId })
          if (inFlight.length > maximumEntries) break fill
        }
      }
    }
  }
  const clients = valid(clientKindSchema, all(read, "client"))
  const kept = {
    clients,
    requestedAt: valid(dateTimeSchema, all(read, "requestedAt"))[0] ?? new Date().toISOString(),
    sessionIds: sessionIds.slice(0, maximumEntries),
    inFlight: inFlight.slice(0, maximumEntries),
  }
  const work = Math.max(1, clients.length * kept.sessionIds.length + kept.inFlight.length)
  const finished = stopIds.slice(0, Math.max(1, Math.floor(maximumWork / work)))
  const overflow = sessionIds.length > maximumEntries || inFlight.length > maximumEntries || finished.length < stopIds.length
    ? `The record asks for more than one restart finishes (${stopIds.length} stop ids, ${sessionIds.length} sessions); what fits is finished`
    : undefined
  return {
    intents: finished.map((stopId) => ({ stopId, ...kept })),
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
  readonly #dispatchBuilt: (() => void) | undefined
  readonly #rowsPerPass: number

  // `onDispatchBuilt` is a test seam: it is told of each in-flight entry the
  // restart's reader makes, so the cap on them can be counted, not timed.
  // `rowsPerPass` is one too, so a test can span passes with a few rows.
  constructor(database: DatabaseSync, options: { onDispatchBuilt?: () => void; rowsPerPass?: number } = {}) {
    this.#database = database
    this.#dispatchBuilt = options.onDispatchBuilt
    this.#rowsPerPass = options.rowsPerPass ?? emergencyStopRowsPerPass
    database.exec(`CREATE TABLE IF NOT EXISTS emergency_stop_intents (
      stop_id TEXT PRIMARY KEY,
      record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= ${maximumEmergencyStopIntentBytes})
    )`)
    database.exec("CREATE TABLE IF NOT EXISTS emergency_stop_recovery (stop_id TEXT PRIMARY KEY)")
    // Owner ruling Q93 B on #641: what one recovery has read and the lines it
    // will write, kept in the store rather than in memory. See `stage`.
    database.exec(`CREATE TABLE IF NOT EXISTS emergency_stop_recovery_rows (
      row INTEGER NOT NULL, identity TEXT NOT NULL, keep INTEGER NOT NULL, cleared INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (row, identity)
    )`)
    database.exec(`CREATE TABLE IF NOT EXISTS emergency_stop_recovery_lines (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, client TEXT NOT NULL, created_at TEXT NOT NULL
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
  //
  // Issue #632: one call is one pass over at most `rowsPerPass` rows, those
  // after `after` in rowid order. The rows past it stay in the journal as
  // they are, and `next` says where the pass that reads them starts; it is
  // absent once no row is left. Each stop carries the rowid of its row, so
  // the caller clears that row and no other: SQLite lets a text primary key
  // hold many nulls, so a key does not always name one row.
  //
  // Security review round 2 of #641: a row this recovery has already read,
  // as `stage` lists it, is passed over: a row kept for overflow, or one a
  // clear or a move could not remove. `read` lists each row the pass read
  // that stays in the journal for now, for `stage` to list: the rows to
  // finish (`keep` false, cleared once the round is saved), those kept for
  // overflow, and any unreadable row that could not be moved aside.
  pending(after?: bigint): {
    intents: Array<{ key: SQLInputValue; row: bigint; intent: RecoveredEmergencyStopIntent; keep: boolean }>
    partial: Array<{ key: string; reason: string }>
    overflow: Array<{ key: string; reason: string }>
    setAside: Array<{ key: string; reason: string }>
    read: Array<{ row: bigint; identity: string; keep: boolean }>
    next?: bigint
  } {
    const from = after === undefined ? "" : "WHERE rowid > ?"
    const select = this.#database.prepare(`SELECT rowid AS row, stop_id, record FROM emergency_stop_intents ${from} ORDER BY rowid LIMIT ?`)
    // Rowids are read whole: a crafted one can be past a number's exact range.
    select.setReadBigInts(true)
    const rows = (after === undefined ? select.all(this.#rowsPerPass) : select.all(after, this.#rowsPerPass)) as JournalRow[]
    const listed = this.#database.prepare("SELECT 1 FROM emergency_stop_recovery_rows WHERE row = ? AND identity = ?")
    const intents: Array<{ key: SQLInputValue; row: bigint; intent: RecoveredEmergencyStopIntent; keep: boolean }> = []
    const partial: Array<{ key: string; reason: string }> = []
    const overflow: Array<{ key: string; reason: string }> = []
    const setAside: Array<{ key: string; reason: string }> = []
    const readRows: Array<{ row: bigint; identity: string; keep: boolean }> = []
    for (const row of rows) {
      const identity = rowIdentity(row.stop_id, row.record)
      if (listed.get(row.row, identity) !== undefined) continue
      const read = readIntent(row.stop_id, row.record, this.#dispatchBuilt)
      if ("unreadable" in read) {
        if (!this.#quarantine(row, read.unreadable, true).moved) readRows.push({ row: row.row, identity, keep: true })
        setAside.push({ key: String(row.stop_id), reason: read.unreadable })
        continue
      }
      if (read.partial !== undefined && this.#quarantine(row, read.partial, false).copied) {
        partial.push({ key: String(row.stop_id), reason: read.partial })
      }
      if (read.overflow !== undefined) overflow.push({ key: String(row.stop_id), reason: read.overflow })
      readRows.push({ row: row.row, identity, keep: read.overflow !== undefined })
      for (const intent of read.intents) intents.push({ key: row.stop_id, row: row.row, intent, keep: read.overflow !== undefined })
    }
    const last = rows.at(-1)?.row
    const more = last !== undefined && rows.length === this.#rowsPerPass
      && this.#database.prepare("SELECT 1 FROM emergency_stop_intents WHERE rowid > ? LIMIT 1").get(last) !== undefined
    return { intents, partial, overflow, setAside, read: readRows, ...(more ? { next: last } : {}) }
  }

  clear(key: SQLInputValue): void {
    this.#database.prepare("DELETE FROM emergency_stop_intents WHERE stop_id IS ?").run(key)
  }

  // Clears the one row a stop was read from, by its rowid.
  clearRow(row: bigint): void {
    this.#database.prepare("DELETE FROM emergency_stop_intents WHERE rowid = ?").run(row)
  }

  // Owner ruling Q93 B on #641: recovery reads the journal in rounds, each a
  // sequence of passes followed by one save of the workspace. A pass writes
  // what it did here, not into a copy of the workspace, so what a pass holds
  // does not grow with the passes before it:
  //
  // - `emergency_stop_recovery_rows` lists each row the recovery has read, by
  //   rowid and identity, and whether it is kept. `pending` passes over a
  //   listed row, and `finishRound` clears the rows to finish.
  // - `emergency_stop_recovery_lines` holds the lines the round will write,
  //   each once, in the order the passes wrote them.
  // - `emergency_stop_recovery` (review round 1) lists the stops the
  //   recovery has acted on. A line of a listed stop does not count as its
  //   record, so a row read in a later round, or after a restart, still acts.
  //
  // The first two hold nothing the workspace does not: until a round's save
  // lands, the journal still holds every row the round read, so a start that
  // ends before then discards them (`beginRecovery`) and reads those rows
  // again. The stop list is kept until the whole recovery is done, across
  // restarts.
  beginRecovery(): void {
    this.#database.exec("DELETE FROM emergency_stop_recovery_rows")
    this.#database.exec("DELETE FROM emergency_stop_recovery_lines")
  }

  stage({ read, acted, lines }: {
    read: ReadonlyArray<{ row: bigint; identity: string; keep: boolean }>
    acted: Iterable<string>
    lines: ReadonlyArray<{ id: string; sessionId: string; client: string; createdAt: string }>
  }): void {
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const row = this.#database.prepare("INSERT OR IGNORE INTO emergency_stop_recovery_rows (row, identity, keep) VALUES (?, ?, ?)")
      for (const { row: rowid, identity, keep } of read) row.run(rowid, identity, keep ? 1 : 0)
      const stop = this.#database.prepare("INSERT OR IGNORE INTO emergency_stop_recovery (stop_id) VALUES (?)")
      for (const stopId of acted) stop.run(stopId)
      const line = this.#database.prepare("INSERT OR IGNORE INTO emergency_stop_recovery_lines (id, session_id, client, created_at) VALUES (?, ?, ?, ?)")
      for (const { id, sessionId, client, createdAt } of lines) line.run(id, sessionId, client, createdAt)
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  recovering(stopIds: Iterable<string>): Set<string> {
    const listed = this.#database.prepare("SELECT 1 FROM emergency_stop_recovery WHERE stop_id = ?")
    return new Set([...stopIds].filter((stopId) => listed.get(stopId) !== undefined))
  }

  // The round's lines, in the order the passes wrote them, one at a time.
  stagedLines(): Iterable<{ id: string; sessionId: string; client: string; createdAt: string }> {
    const lines = this.#database.prepare("SELECT id, session_id, client, created_at FROM emergency_stop_recovery_lines ORDER BY seq").iterate()
    return (function* () {
      for (const line of lines as Iterable<{ id: string; session_id: string; client: string; created_at: string }>) {
        yield { id: line.id, sessionId: line.session_id, client: line.client, createdAt: line.created_at }
      }
    })()
  }

  // Once the round's save has landed: clears each row it finished, once,
  // and only while that row is still the one the round read, by identity.
  // A row cleared is no longer listed, so a row that takes its rowid is read
  // by the next round. A row whose clear did not remove it (a trigger in the
  // store can refuse it) stays listed, so it is not read again. The round's
  // lines are dropped: the workspace holds them now.
  finishRound(): void {
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const next = this.#database.prepare("SELECT row, identity FROM emergency_stop_recovery_rows WHERE keep = 0 AND cleared = 0 LIMIT ?")
      next.setReadBigInts(true)
      const current = this.#database.prepare("SELECT stop_id, record FROM emergency_stop_intents WHERE rowid = ?")
      current.setReadBigInts(true)
      const clear = this.#database.prepare("DELETE FROM emergency_stop_intents WHERE rowid = ?")
      const forget = this.#database.prepare("DELETE FROM emergency_stop_recovery_rows WHERE row = ? AND identity = ?")
      const held = this.#database.prepare("UPDATE emergency_stop_recovery_rows SET cleared = 1 WHERE row = ? AND identity = ?")
      for (;;) {
        const listed = next.all(this.#rowsPerPass) as Array<{ row: bigint; identity: string }>
        if (listed.length === 0) break
        for (const { row, identity } of listed) {
          const stored = current.get(row) as { stop_id: SQLInputValue; record: SQLInputValue } | undefined
          const same = stored !== undefined && rowIdentity(stored.stop_id, stored.record) === identity
          if (same && Number(clear.run(row).changes) === 0) held.run(row, identity)
          else forget.run(row, identity)
        }
      }
      this.#database.exec("DELETE FROM emergency_stop_recovery_lines")
      this.#database.exec("COMMIT")
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }

  // The recovery is done: from here on its lines record their stops.
  finishRecovery(): void {
    this.#database.exec("DELETE FROM emergency_stop_recovery")
    this.beginRecovery()
  }

  // Copies the row as stored to the quarantine table, and moves it there
  // when `move`. A copy already there is not made twice. Answers whether
  // this call made the copy, and whether it moved the row: the move removes
  // the row only while it is the one read. Issue #632: the copy is found
  // through an index on the identity it is matched by, not by reading the
  // whole table, so a journal of many such rows costs a restart time in
  // proportion to its length. The index is made if missing, over the rows a
  // store already holds.
  #quarantine({ row, stop_id: key, record }: JournalRow, why: string, move: boolean): { copied: boolean; moved: boolean } {
    this.#database.exec(`CREATE TABLE IF NOT EXISTS emergency_stop_intent_quarantine (
      stop_id, record, reason TEXT NOT NULL, set_aside_at TEXT NOT NULL
    )`)
    this.#database.exec(`CREATE INDEX IF NOT EXISTS emergency_stop_intent_quarantine_identity
      ON emergency_stop_intent_quarantine (stop_id, record)`)
    this.#database.exec("BEGIN IMMEDIATE")
    try {
      const copied = this.#database.prepare("SELECT 1 FROM emergency_stop_intent_quarantine WHERE stop_id IS ? AND record IS ?")
        .get(key, record) !== undefined
      if (!copied) {
        this.#database.prepare("INSERT INTO emergency_stop_intent_quarantine (stop_id, record, reason, set_aside_at) VALUES (?, ?, ?, ?)")
          .run(key, record, why, new Date().toISOString())
      }
      const moved = move && Number(this.#database.prepare("DELETE FROM emergency_stop_intents WHERE rowid = ? AND stop_id IS ? AND record IS ?")
        .run(row, key, record).changes) > 0
      this.#database.exec("COMMIT")
      return { copied: !copied, moved }
    } catch (error) {
      this.#database.exec("ROLLBACK")
      throw error
    }
  }
}
