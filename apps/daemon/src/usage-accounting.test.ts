import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
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
  it("adds distinct messages once, rejects stale snapshots, and keeps requested models", () => {
    const ledger = new UsageLedger()
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
      observations: [expect.objectContaining({ model: "actual/model" }), expect.anything()],
    })
    ledger.close()
  })

  it("preserves failures, missing coverage, late events, dedup and identity across restart and transfer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-accounting-"))
    try {
      const path = join(directory, "usage.sqlite")
      let ledger = new UsageLedger(path)
      ledger.begin(dispatch)
      ledger.observe(dispatch, observation("message-1", 10))
      ledger.finish(dispatch, "failed")
      const missing = { ...dispatch, turnId: "no-usage" }
      ledger.begin(missing)
      ledger.close()
      ledger = new UsageLedger(path)
      ledger.interruptPending()
      ledger.observe(dispatch, observation("message-2", 30))
      const exported = ledger.transferSession(dispatch.sessionId)
      expect(JSON.stringify(exported)).not.toContain(dispatch.threadId)
      const target = new UsageLedger()
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
      target.close()
      ledger.close()
    } finally {
      await removeScratchDirectory(directory)
    }
  })

  it("uses provider/thread/turn identity and refuses events without a dispatch", () => {
    const ledger = new UsageLedger()
    ledger.begin(dispatch)
    const other = { ...dispatch, threadId: "replacement-thread", model: "next/model" }
    ledger.begin(other)
    ledger.observe(dispatch, observation("same-message", 10))
    ledger.observe(other, observation("same-message", 20))
    expect(ledger.observe({ ...dispatch, turnId: "unknown" }, observation("unknown", 100))).toBe(false)
    expect(ledger.session(dispatch.sessionId)).toMatchObject({ totalTokens: 34 })
    expect(ledger.transferSession(dispatch.sessionId)).toHaveLength(2)
    ledger.close()
  })

  it("marks invalid and missing reports as partial instead of reporting complete zero usage", () => {
    const ledger = new UsageLedger()
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
    ledger.close()
  })

  it("keeps cumulative ACP session costs separate from per-turn consumption", () => {
    const ledger = new UsageLedger()
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
    ledger.close()
  })

  it("rejects forged transfer metadata atomically", () => {
    const ledger = new UsageLedger()
    ledger.begin(dispatch)
    ledger.observe(dispatch, observation("message", 10))
    ledger.finish(dispatch, "completed")
    const rows = ledger.transferSession(dispatch.sessionId)
    const forged = structuredClone(rows)
    forged[0]!.accounting!.requestedModel = "other-model"
    expect(() => ledger.replaceTransferredSession(dispatch.sessionId, forged)).toThrow()
    expect(ledger.transferSession(dispatch.sessionId)).toEqual(rows)
    ledger.close()
  })
})
