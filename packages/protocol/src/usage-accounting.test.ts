import { describe, expect, it } from "vitest"
import { usageAccountingSchema, usageCoverageSchema } from "./usage-accounting.js"
import { sessionTransferUsageRecordSchema } from "./transfer-contract.js"

const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3,
  reasoningTokens: 1, totalTokens: 14, costSource: "unavailable" as const }
const accounting = {
  version: 1, key: "a".repeat(64), threadKey: "b".repeat(64),
  provider: "opencode", requestedModel: "requested", providerTurnId: "provider-turn", status: "completed",
  coverage: "complete",
  observations: [{ kind: "message", id: "message", model: "reported", tokens: "reported",
    final: true, invalid: false, usage }],
}

describe("usage accounting contracts", () => {
  it("validates portable accounting identity, coverage and provider observations", () => {
    expect(usageAccountingSchema.parse(accounting)).toEqual(accounting)
    const record = { turnId: accounting.key, provider: "opencode", model: "requested", ...usage, accounting }
    expect(sessionTransferUsageRecordSchema.parse(record)).toEqual(record)
    expect(usageCoverageSchema.parse({ pending: 0, complete: 1, partial: 0, unavailable: 0, legacy: 0 }))
      .toMatchObject({ complete: 1 })
  })

  it.each([
    { key: "raw-thread-id" }, { version: 2 }, { status: "guessed" }, { coverage: "guessed" },
    { provider: "" }, { provider: "a".repeat(65) }, { provider: undefined },
    { requestedModel: "" }, { providerTurnId: "" }, { observations: [accounting.observations[0], accounting.observations[0]] },
    { observations: [] }, { coverage: "unavailable" }, { status: "pending" },
    { observations: [{ ...accounting.observations[0], usage: { ...usage, cachedInputTokens: 11 } }] },
    { observations: [{ ...accounting.observations[0], usage: { ...usage, totalTokens: 1 } }] },
    { observations: [{ ...accounting.observations[0], usage: { ...usage, costSource: "provider-reported" } }] },
    { observations: [{ ...accounting.observations[0], usage: { ...usage, inputTokens: -1 } }] },
  ])("rejects invalid accounting metadata %j", (change) => {
    expect(usageAccountingSchema.safeParse({ ...accounting, ...change }).success).toBe(false)
  })

  it("rejects transfers that disagree with their accounting evidence", () => {
    const record = { turnId: accounting.key, provider: "opencode", model: "requested", ...usage, accounting }
    for (const change of [{ turnId: "unrelated" }, { provider: "claude-code" }, { model: "other" }, { totalTokens: 100 }]) {
      expect(sessionTransferUsageRecordSchema.safeParse({ ...record, ...change }).success).toBe(false)
    }
  })

  it.each([
    [Number.MAX_SAFE_INTEGER - 1, 1, Number.MAX_SAFE_INTEGER, true],
    [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, false],
    [Number.MAX_SAFE_INTEGER, 2, Number.MAX_SAFE_INTEGER + 2, false],
  ] as const)("bounds aggregate counters even when addition rounds: %s + %s", (first, second, declared, accepted) => {
    const counts = (value: number) => ({ ...usage, inputTokens: value, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: value })
    const evidence = { ...accounting, observations: [first, second].map((value, index) => ({
      ...accounting.observations[0], id: `message-${index}`, usage: counts(value),
    })) }
    const record = { turnId: accounting.key, provider: "opencode", model: "requested", ...counts(declared), accounting: evidence }
    expect(sessionTransferUsageRecordSchema.safeParse(record).success).toBe(accepted)
  })
})
