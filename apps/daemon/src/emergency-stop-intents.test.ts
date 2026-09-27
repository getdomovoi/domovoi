import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"

import { SqliteEmergencyStopIntents } from "./emergency-stop-intents.js"

const stopId = `stop-${"9".repeat(8)}-9999-4999-8999-${"9".repeat(12)}`

function journalWith(record: string, options: ConstructorParameters<typeof SqliteEmergencyStopIntents>[1] = {}): SqliteEmergencyStopIntents {
  const database = new DatabaseSync(":memory:")
  const journal = new SqliteEmergencyStopIntents(database, options)
  database.prepare("INSERT INTO emergency_stop_intents (stop_id, record) VALUES (?, ?)").run(stopId, record)
  return journal
}

// Every row here is a damaged journal: only the daemon writes it. Reading one
// must finish in bounded time and memory, whatever it repeats.
describe("reading a damaged emergency stop journal", () => {
  // Security review round 6 of #628: one in-flight entry that repeats its
  // provider and thread keys names every pair of them. A 2,000 by 2,000 row
  // (about 80 KB) names four million; no more than the kept number is built.
  it("builds no more dispatch pairs than it keeps, however many a row names", () => {
    const providers = Array.from({ length: 2_000 }, (_, index) => `"provider":"p${index}"`).join(",")
    const threads = Array.from({ length: 2_000 }, (_, index) => `"providerThreadId":"t${index}"`).join(",")
    const record = `{"version":1,"stopId":"${stopId}","client":"desktop","requestedAt":"2026-09-26T10:00:00.000Z",`
      + `"sessionIds":["session-a"],"inFlight":[{"sessionId":"session-a",${providers},${threads}}]}`
    let built = 0
    const journal = journalWith(record, { onDispatchBuilt: () => { built += 1 } })

    const { intents, overflow } = journal.pending()

    expect(intents).toHaveLength(1)
    expect(intents[0]!.intent.inFlight).toHaveLength(10_000)
    expect(overflow).toHaveLength(1)
    // Counted, not timed: the kept 10,000 and the one that shows there are
    // more, never the four million the row names.
    expect(built).toBe(10_001)
  })

  // Round 6: a row that lists the same session twice in the stop's own format
  // must not name it twice, or its restart line would repeat an id.
  it("names each session once from a row in the stop's own format", () => {
    const record = JSON.stringify({
      version: 1, stopId, client: "desktop", requestedAt: "2026-09-26T10:00:00.000Z", sessionIds: ["session-a", "session-a"],
    })
    const { intents } = journalWith(record).pending()
    expect(intents.map(({ intent }) => intent.sessionIds)).toEqual([["session-a"]])
  })

  // Round 6: a row may name many distinct stop ids, each finished for every
  // session. The work one row asks of a restart is bounded: what fits is
  // finished, and the row is kept and reported.
  it("bounds the work one row asks of a restart, and keeps the row when it asks for more", () => {
    const stopIds = Array.from({ length: 15_000 }, (_, index) =>
      `"stopId":"stop-${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000"`).join(",")
    const record = `{"version":1,${stopIds},"client":"desktop","requestedAt":"2026-09-26T10:00:00.000Z","sessionIds":["session-a","session-b"]}`
    const { intents, overflow } = journalWith(record).pending()
    expect(intents.length).toBeLessThanOrEqual(10_000)
    expect(intents.every(({ keep }) => keep)).toBe(true)
    expect(overflow).toHaveLength(1)
  })
})

const stopAt = (index: number) => `stop-${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`
const readable = (id: string) => JSON.stringify({ version: 1, stopId: id, client: "desktop", requestedAt: "2026-09-26T10:00:00.000Z", sessionIds: ["session-a"] })
// A stop beside a field it does not know: read in part, so copied aside.
const readInPart = (id: string) => JSON.stringify({ version: 1, stopId: id, client: "desktop", requestedAt: "2026-09-26T10:00:00.000Z", sessionIds: ["session-a"], addedLater: true })
const insert = (database: DatabaseSync, key: string | null, record: string) => {
  database.prepare("INSERT INTO emergency_stop_intents (stop_id, record) VALUES (?, ?)").run(key, record)
}
const stored = (database: DatabaseSync, table: string) =>
  (database.prepare(`SELECT count(*) AS rows FROM ${table}`).get() as { rows: number }).rows

// Every statement the journal prepares, so a test can ask SQLite how each
// one reads its table.
function recording(database: DatabaseSync, statements: string[]): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql) }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

// The statements that read the whole quarantine table, as SQLite plans them.
const quarantineScans = (database: DatabaseSync, statements: string[]) => statements.filter((sql) =>
  database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().some(({ detail }) => /^SCAN emergency_stop_intent_quarantine\b/.test(String(detail))))

// Every pass a restart makes over the journal, each resuming where the last stopped.
function passes(journal: SqliteEmergencyStopIntents): Array<ReturnType<SqliteEmergencyStopIntents["pending"]>> {
  const made: Array<ReturnType<SqliteEmergencyStopIntents["pending"]>> = []
  let after: bigint | undefined
  do {
    const pass = journal.pending(after)
    made.push(pass)
    after = pass.next
  } while (after !== undefined && made.length < 100)
  return made
}

// Issue #632, from the #628 review: a damaged journal may hold any number of
// rows. Each row's own work is capped; a restart's work across them must be
// bounded too.
describe("reading a damaged emergency stop journal of many rows", () => {
  // Each row read only in part asks whether its copy is already aside. That
  // lookup must not read the whole quarantine table, or a journal of many
  // such rows makes the restart quadratic in its size. Counted from SQLite's
  // own plan for each statement the journal runs, not timed.
  it("looks up each partial row's stored copy without scanning the quarantine table", () => {
    const database = new DatabaseSync(":memory:")
    const statements: string[] = []
    const journal = new SqliteEmergencyStopIntents(recording(database, statements))
    for (let index = 0; index < 8; index += 1) insert(database, stopAt(index), readInPart(stopAt(index)))

    const partial = passes(journal).flatMap((pass) => pass.partial)

    expect(partial).toHaveLength(8)
    expect(stored(database, "emergency_stop_intent_quarantine")).toBe(8)
    expect(quarantineScans(database, statements)).toEqual([])
  })

  // A store an earlier build wrote has the quarantine table without its
  // index. The copy already there still counts, and is not made twice.
  it("indexes a quarantine table an earlier build made, and still copies a row there once", () => {
    const database = new DatabaseSync(":memory:")
    database.exec("CREATE TABLE emergency_stop_intent_quarantine (stop_id, record, reason TEXT NOT NULL, set_aside_at TEXT NOT NULL)")
    const record = readInPart(stopAt(1))
    database.prepare("INSERT INTO emergency_stop_intent_quarantine (stop_id, record, reason, set_aside_at) VALUES (?, ?, ?, ?)")
      .run(stopAt(1), record, "An earlier restart", "2026-09-26T10:00:00.000Z")
    const statements: string[] = []
    const journal = new SqliteEmergencyStopIntents(recording(database, statements))
    insert(database, stopAt(1), record)

    const made = passes(journal)

    expect(made.flatMap((pass) => pass.intents.map(({ intent }) => intent.stopId))).toEqual([stopAt(1)])
    expect(made.flatMap((pass) => pass.partial)).toEqual([])
    expect(stored(database, "emergency_stop_intent_quarantine")).toBe(1)
    expect(quarantineScans(database, statements)).toEqual([])
  })

  // pending() used to load every row, and every stop read from them, before
  // any was finished. A pass now loads a bounded number of rows, leaves the
  // rest in the journal, and says where the next pass starts.
  it("loads no more rows than one pass holds, and leaves the rest for the next pass", () => {
    const database = new DatabaseSync(":memory:")
    const journal = new SqliteEmergencyStopIntents(database, { rowsPerPass: 4 })
    for (let index = 0; index < 10; index += 1) insert(database, stopAt(index), readable(stopAt(index)))

    const first = journal.pending()
    expect(first.intents.map(({ intent }) => intent.stopId)).toEqual([0, 1, 2, 3].map(stopAt))
    expect(first.next).toBeDefined()
    expect(stored(database, "emergency_stop_intents")).toBe(10)

    const made = passes(journal)
    expect(made.map((pass) => pass.intents.map(({ intent }) => intent.stopId)))
      .toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]].map((pass) => pass.map(stopAt)))
    expect(made.at(-1)!.next).toBeUndefined()
  })

  it("bounds the rows one pass loads without being told a number", () => {
    const database = new DatabaseSync(":memory:")
    const journal = new SqliteEmergencyStopIntents(database)
    for (let index = 0; index < 64; index += 1) insert(database, stopAt(index), readable(stopAt(index)))

    const first = journal.pending()

    expect(first.intents.length).toBeGreaterThan(0)
    expect(first.intents.length).toBeLessThan(64)
    expect(first.next).toBeDefined()
    expect(passes(journal).flatMap((pass) => pass.intents.map(({ intent }) => intent.stopId))).toEqual(Array.from({ length: 64 }, (_, index) => stopAt(index)))
  })

  // A key is not always unique: SQLite lets a text primary key hold many
  // nulls. Setting one row aside moves that row, not every row under its key,
  // so a readable row a later pass holds is still there to finish.
  it("sets aside an unreadable row without taking a readable row stored under the same key", () => {
    const database = new DatabaseSync(":memory:")
    const journal = new SqliteEmergencyStopIntents(database, { rowsPerPass: 2 })
    insert(database, null, "{ not json")
    for (let index = 0; index < 3; index += 1) insert(database, null, readable(stopAt(index)))

    const made = passes(journal)

    expect(made.flatMap((pass) => pass.setAside)).toHaveLength(1)
    expect(made.flatMap((pass) => pass.intents.map(({ intent }) => intent.stopId))).toEqual([0, 1, 2].map(stopAt))
    expect(stored(database, "emergency_stop_intents")).toBe(3)
    expect(stored(database, "emergency_stop_intent_quarantine")).toBe(1)
  })

  // Clearing a finished row clears that row, for the same reason.
  it("clears one row, not every row stored under its key", () => {
    const database = new DatabaseSync(":memory:")
    const journal = new SqliteEmergencyStopIntents(database)
    insert(database, null, readable(stopAt(0)))
    insert(database, null, readable(stopAt(1)))

    const [finished] = journal.pending().intents
    journal.clearRow(finished!.row)

    expect(journal.pending().intents.map(({ intent }) => intent.stopId)).toEqual([stopAt(1)])
  })

  // Security review round 2 of #641: a round clears a row it finished only
  // while that row is still the one it read, by key and record. A row that
  // took its place under the same rowid is left for the next round to read,
  // and a row the round read and left in place is passed over.
  it("clears a finished row only while it is the row the round read", () => {
    const database = new DatabaseSync(":memory:")
    const journal = new SqliteEmergencyStopIntents(database)
    insert(database, stopAt(0), readable(stopAt(0)))
    insert(database, stopAt(1), readable(stopAt(1)))
    journal.beginRecovery()
    journal.stage({ read: journal.pending().read, acted: [], lines: [] })
    database.prepare("UPDATE emergency_stop_intents SET record = ? WHERE stop_id = ?").run(readable(stopAt(2)), stopAt(1))

    journal.finishRound()

    expect(stored(database, "emergency_stop_intents")).toBe(1)
    expect(journal.pending().intents.map(({ intent }) => intent.stopId)).toEqual([stopAt(2)])
  })

  // Security review round 3 of #641: finishRound takes the rows to clear a
  // batch at a time. Rows kept for overflow and rows whose clear was refused
  // stay listed, so each batch must not read past them again, or a round's
  // clear grows with the square of the rows it read. Counted, not timed:
  // `visited` is how many listed rows SQLite reads while the round clears.
  it("clears a round's rows without reading the kept and refused ones again for each batch", () => {
    const small = roundClearVisits(96)
    const large = roundClearVisits(4 * 96)

    expect(small.left).toEqual({ journal: 64, listed: 64 })
    expect(large.left).toEqual({ journal: 256, listed: 256 })
    // Four times the rows, about four times the reads: one batch of slack.
    expect(large.visited).toBeLessThanOrEqual(4 * small.visited + 16)
  })

  it("plans the query for a round's rows to clear without reading every listed row", () => {
    const database = new DatabaseSync(":memory:")
    const statements: string[] = []
    const journal = new SqliteEmergencyStopIntents(recording(database, statements))
    insert(database, stopAt(0), readable(stopAt(0)))
    journal.beginRecovery()
    journal.stage({ read: journal.pending().read, acted: [], lines: [] })
    statements.length = 0

    journal.finishRound()

    expect(statements.filter((sql) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
      .some(({ detail }) => /^SCAN emergency_stop_recovery_rows$/.test(String(detail))))).toEqual([])
  })
})

// Stages `count` journal rows as one round read them: a third kept for
// overflow, a third whose clear a trigger refuses, a third to clear,
// interleaved. Then counts the listed rows SQLite reads while the round
// clears. A temporary view in front of the listed rows' table (SQLite looks
// in `temp` first) calls `visit` for each row it reads, and triggers pass the
// round's writes through to the table.
function roundClearVisits(count: number): { visited: number; left: { journal: number; listed: number } } {
  const database = new DatabaseSync(":memory:")
  const journal = new SqliteEmergencyStopIntents(database)
  for (let index = 0; index < count; index += 1) insert(database, stopAt(index), readable(stopAt(index)))
  database.exec(`CREATE TRIGGER refused BEFORE DELETE ON emergency_stop_intents WHEN old.rowid % 3 = 2
    BEGIN SELECT RAISE(IGNORE); END`)
  journal.beginRecovery()
  const read = passes(journal).flatMap((pass) => pass.read)
  journal.stage({ read: read.map((row) => ({ ...row, keep: row.row % 3n === 1n })), acted: [], lines: [] })

  let visited = 0
  database.function("visit", { varargs: true }, () => { visited += 1; return 1 })
  database.exec(`CREATE TEMP VIEW emergency_stop_recovery_rows AS
    SELECT row, identity, keep, cleared FROM main.emergency_stop_recovery_rows WHERE visit(row)`)
  database.exec(`CREATE TEMP TRIGGER held INSTEAD OF UPDATE ON emergency_stop_recovery_rows BEGIN
    UPDATE main.emergency_stop_recovery_rows SET cleared = new.cleared WHERE row = old.row AND identity = old.identity;
  END`)
  database.exec(`CREATE TEMP TRIGGER forget INSTEAD OF DELETE ON emergency_stop_recovery_rows BEGIN
    DELETE FROM main.emergency_stop_recovery_rows WHERE row = old.row AND identity = old.identity;
  END`)

  journal.finishRound()

  database.exec("DROP VIEW temp.emergency_stop_recovery_rows")
  return { visited, left: { journal: stored(database, "emergency_stop_intents"), listed: stored(database, "emergency_stop_recovery_rows") } }
}
