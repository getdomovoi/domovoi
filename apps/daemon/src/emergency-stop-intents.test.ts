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
