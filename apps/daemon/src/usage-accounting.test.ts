import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { UsageLedger, normalizeUsage } from "./usage.js"
import { removeScratchDirectory } from "./test-scratch.js"

const dispatch = {
  sessionId: "session", provider: "opencode", model: "requested/model",
  threadId: "provider-thread", turnId: "provider-turn",
}
const observation = (id: string, inputTokens: number, final = true) => ({
  usage: normalizeUsage({ inputTokens, outputTokens: 2, cost: { amount: 0.01, currency: "USD" } }),
  source: { kind: "message" as const, id, tokens: "reported" as const, final, model: "actual/model" },
})

describe("durable usage accounting", () => {
  it.each(["transfer", "begin"])("preserves the %s failure when SQLite has already rolled back", async (operation) => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-accounting-rollback-"))
    const path = join(directory, "usage.sqlite")
    const ledger = new UsageLedger(path)
    try {
      ledger.begin(dispatch)
      const before = ledger.transferSession(dispatch.sessionId)
      const database = new DatabaseSync(path)
      try {
        const event = operation === "begin" ? "INSERT" : "DELETE"
        database.exec(`CREATE TRIGGER rollback_usage_write BEFORE ${event} ON provider_usage BEGIN SELECT RAISE(ROLLBACK, 'usage transaction failure'); END`)
      } finally { database.close() }
      let failure: unknown
      try {
        if (operation === "begin") ledger.begin({ ...dispatch, turnId: "new-turn" })
        else ledger.replaceTransferredSession(dispatch.sessionId, [])
      } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure).toMatchObject({
        cause: expect.objectContaining({ message: "usage transaction failure" }),
        errors: [expect.objectContaining({ message: "usage transaction failure" }), expect.any(Error)],
      })
      expect(ledger.transferSession(dispatch.sessionId)).toEqual(before)
    } finally {
      ledger.close()
      await removeScratchDirectory(directory)
    }
  })

  it.each([
    "{",
    JSON.stringify({ version: 1, status: "pending" }),
    JSON.stringify({ turn: { ordinal: "invalid" } }),
    JSON.stringify({ turn: { ordinal: Number.MAX_SAFE_INTEGER } }),
    JSON.stringify({ turn: { ordinal: 3 } }),
    JSON.stringify({ turn: { ordinal: 2 } }),
  ])(
    "keeps corrupt accounting from blocking other rows: %s", async (corrupt) => {
      const directory = await mkdtemp(join(tmpdir(), "domovoi-accounting-corrupt-"))
      const path = join(directory, "usage.sqlite")
      let ledger: UsageLedger | undefined
      try {
        ledger = new UsageLedger(path)
        ledger.begin(dispatch)
        ledger.observe(dispatch, observation("bad-row-usage", 10))
        const badKey = ledger.lookup(dispatch)!.turnId
        const healthy = { ...dispatch, turnId: "healthy-pending" }
        ledger.begin(healthy)
        ledger.observe(healthy, observation("healthy-usage", 20))
        ledger.close()
        ledger = undefined
        const database = new DatabaseSync(path)
        try {
          // Simulate durable input created before the JSON expression indexes existed.
          database.exec("DROP INDEX IF EXISTS provider_usage_accounting_status; DROP INDEX IF EXISTS provider_usage_turn_ordinal")
          database.prepare("UPDATE provider_usage SET accounting = ? WHERE turn_id = ?").run(corrupt, badKey)
        } finally { database.close() }

        ledger = new UsageLedger(path)
        ledger.interruptPending()
        expect(ledger.lookup(dispatch)?.accounting).toBeUndefined()
        expect(ledger.lookup(healthy)?.accounting?.status).toBe("interrupted")
        expect(ledger.observe(dispatch, observation("untrusted-late", 100))).toBe(false)
        expect(ledger.session(dispatch.sessionId)).toMatchObject({
          totalTokens: 34, coverage: { legacy: 1, complete: 1, pending: 0 },
        })
        expect(ledger.window(0, Date.now() + 1000)).toMatchObject({
          totalTokens: 34, coverage: { legacy: 1, complete: 1, pending: 0 },
        })
        expect(ledger.transferSession(dispatch.sessionId)).toHaveLength(2)
        const next = { ...dispatch, turnId: "next-turn" }
        ledger.begin(next)
        expect(ledger.lookup(next)?.accounting?.turn?.ordinal).toBe(3)
      } finally {
        ledger?.close()
        await removeScratchDirectory(directory)
      }
    },
  )

  it("reconstructs allocation from valid evidence when the cached ordinal is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-ordinal-cache-"))
    const path = join(directory, "usage.sqlite")
    let ledger: UsageLedger | undefined
    try {
      ledger = new UsageLedger(path)
      ledger.begin(dispatch)
      const before = ledger.transferSession(dispatch.sessionId)
      ledger.close()
      ledger = undefined
      const database = new DatabaseSync(path)
      try {
        database.prepare("UPDATE provider_usage SET turn_ordinal = ?").run(Number.MAX_SAFE_INTEGER)
      } finally { database.close() }

      ledger = new UsageLedger(path)
      expect(ledger.transferSession(dispatch.sessionId)).toEqual(before)
      const next = { ...dispatch, turnId: "next-after-repair" }
      ledger.begin(next)
      expect(ledger.lookup(next)?.accounting?.turn?.ordinal).toBe(2)
    } finally {
      ledger?.close()
      await removeScratchDirectory(directory)
    }
  })

  it("states when valid history has exhausted turn ordinals without changing it", () => {
    const ledger = new UsageLedger()
    onTestFinished(() => ledger.close())
    ledger.begin(dispatch)
    const records = ledger.transferSession(dispatch.sessionId)
    records[0]!.accounting!.turn!.ordinal = Number.MAX_SAFE_INTEGER - 1
    ledger.replaceTransferredSession(dispatch.sessionId, records)

    const last = { ...dispatch, turnId: "last-safe-turn" }
    ledger.begin(last)
    expect(ledger.lookup(last)?.accounting?.turn?.ordinal).toBe(Number.MAX_SAFE_INTEGER)
    const before = ledger.transferSession(dispatch.sessionId)
    expect(() => ledger.begin({ ...dispatch, turnId: "overflow-turn" }))
      .toThrow("Cannot begin another turn: this session has exhausted its turn ordinals")
    expect(ledger.transferSession(dispatch.sessionId)).toEqual(before)

    const other = { ...dispatch, sessionId: "other-session", turnId: "other-turn" }
    ledger.begin(other)
    expect(ledger.lookup(other)?.accounting?.turn?.ordinal).toBe(1)
  })

  it("adds distinct messages once, rejects stale snapshots, and keeps requested models", () => {
    const ledger = new UsageLedger()
    onTestFinished(() => ledger.close())
    ledger.begin(dispatch)
    ledger.observe(dispatch, observation("message-1", 10, false))
    ledger.observe(dispatch, observation("message-1", 20))
    ledger.observe(dispatch, observation("message-1", 5))
    ledger.observe(dispatch, observation("message-1", 10, false))
    ledger.observe(dispatch, observation("message-1", 20))
    ledger.observe(dispatch, observation("message-2", 30))
    ledger.finish(dispatch, "completed")
    expect(ledger.session(dispatch.sessionId)).toMatchObject({
      inputTokens: 50, outputTokens: 4, totalTokens: 54, costMicros: 20_000,
      coverage: { complete: 1, partial: 0, unavailable: 0, pending: 0, legacy: 0 },
      byRuntime: [expect.objectContaining({ model: "requested/model", turns: 1 })],
    })
    expect(ledger.transferSession(dispatch.sessionId)[0]?.accounting).toMatchObject({
      requestedModel: "requested/model", providerTurnId: "provider-turn", status: "completed",
      provider: "opencode",
      observations: [expect.objectContaining({ model: "actual/model" }), expect.anything()],
    })
  })

  it("preserves failures, missing coverage, late events, dedup and identity across restart and transfer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-accounting-"))
    let ledger: UsageLedger | undefined
    let target: UsageLedger | undefined
    try {
      const path = join(directory, "usage.sqlite")
      ledger = new UsageLedger(path)
      ledger.begin(dispatch)
      ledger.observe(dispatch, observation("message-1", 10))
      ledger.finish(dispatch, "failed")
      const missing = { ...dispatch, turnId: "no-usage" }
      ledger.begin(missing)
      ledger.close()
      ledger = undefined
      ledger = new UsageLedger(path)
      ledger.interruptPending()
      ledger.observe(dispatch, observation("message-2", 30))
      const exported = ledger.transferSession(dispatch.sessionId)
      expect(JSON.stringify(exported)).not.toContain(dispatch.threadId)
      target = new UsageLedger()
      target.replaceTransferredSession(dispatch.sessionId, exported)
      target.observe(dispatch, observation("message-1", 10))
      target.observe(dispatch, observation("message-2", 30))
      expect(target.session(dispatch.sessionId)).toEqual(ledger.session(dispatch.sessionId))
      expect(target.session(dispatch.sessionId)).toMatchObject({
        totalTokens: 44, coverage: { complete: 1, unavailable: 1, pending: 0 },
      })
      expect(target.transferSession(dispatch.sessionId).map((row) => row.accounting?.status))
        .toEqual(["failed", "interrupted"])
      expect(target.window(0, Date.now() + 1000).totalTokens).toBe(0)
    } finally {
      target?.close()
      ledger?.close()
      await removeScratchDirectory(directory)
    }
  })

  it("uses provider/thread/turn identity and refuses events without a dispatch", () => {
    const ledger = new UsageLedger()
    onTestFinished(() => ledger.close())
    ledger.begin(dispatch)
    const other = { ...dispatch, threadId: "replacement-thread", model: "next/model" }
    ledger.begin(other)
    ledger.observe(dispatch, observation("same-message", 10))
    ledger.observe(other, observation("same-message", 20))
    expect(ledger.observe({ ...dispatch, turnId: "unknown" }, observation("unknown", 100))).toBe(false)
    expect(ledger.session(dispatch.sessionId)).toMatchObject({ totalTokens: 34 })
    expect(ledger.transferSession(dispatch.sessionId)).toHaveLength(2)
  })

  it("marks invalid and missing reports as partial instead of reporting complete zero usage", () => {
    const ledger = new UsageLedger()
    onTestFinished(() => ledger.close())
    ledger.begin(dispatch)
    ledger.observe(dispatch, observation("valid", 10))
    ledger.observe(dispatch, {
      usage: normalizeUsage({}),
      source: { kind: "message", id: "bad", tokens: "unavailable", invalid: true },
    })
    ledger.finish(dispatch, "failed")
    expect(ledger.session(dispatch.sessionId)).toMatchObject({ totalTokens: 12, coverage: { partial: 1 } })
    ledger.observe(dispatch, observation("bad", 20))
    expect(ledger.session(dispatch.sessionId)).toMatchObject({ totalTokens: 34, coverage: { complete: 1 } })
  })

  it("keeps cumulative ACP session costs separate from per-turn consumption", () => {
    const ledger = new UsageLedger()
    onTestFinished(() => ledger.close())
    for (const [turnId, cost] of [["first", 0.01], ["second", 0.03]] as const) {
      const current = { ...dispatch, provider: "cursor-agent", turnId }
      ledger.begin(current)
      ledger.observe(current, {
        usage: normalizeUsage({ contextTokens: 100, contextWindowTokens: 1000,
          cost: { amount: cost, currency: "USD" } }),
        source: { kind: "session", tokens: "unavailable" },
      })
      ledger.finish(current, "completed")
    }
    expect(ledger.session(dispatch.sessionId)).toMatchObject({
      totalTokens: 0, costMicros: 0, coverage: { unavailable: 2 },
      sessionCosts: [expect.objectContaining({ costMicros: 30_000, currency: "USD" })],
    })
  })

  it.each(["requestedModel", "provider"] as const)("rejects forged transfer %s atomically", (field) => {
    const ledger = new UsageLedger()
    onTestFinished(() => ledger.close())
    ledger.begin(dispatch)
    ledger.observe(dispatch, observation("message", 10))
    ledger.finish(dispatch, "completed")
    const rows = ledger.transferSession(dispatch.sessionId)
    const forged = structuredClone(rows)
    forged[0]!.accounting![field] = "other-identity"
    expect(() => ledger.replaceTransferredSession(dispatch.sessionId, forged)).toThrow()
    expect(ledger.transferSession(dispatch.sessionId)).toEqual(rows)
  })
})
