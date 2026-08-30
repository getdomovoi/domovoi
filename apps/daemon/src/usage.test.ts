import { describe, expect, it } from "vitest"

import { UsageLedger, normalizeUsage } from "./usage.js"

describe("provider usage telemetry", () => {
  it("normalizes tokens and provider-reported cost into integer micros", () => {
    expect(normalizeUsage({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 5,
      cost: { amount: 0.03125, currency: "usd" },
    })).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 5,
      totalTokens: 130,
      costMicros: 31_250,
      currency: "USD",
      costSource: "provider-reported",
    })
  })

  it("marks unavailable costs instead of estimating them", () => {
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 4 })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 14,
      costSource: "unavailable",
    })
  })

  it("rejects negative, fractional, and inconsistent token counters", () => {
    expect(() => normalizeUsage({ inputTokens: -1 })).toThrow("non-negative integers")
    expect(() => normalizeUsage({ outputTokens: 1.5 })).toThrow("non-negative integers")
    expect(() => normalizeUsage({ inputTokens: 5, cachedInputTokens: 6 })).toThrow(
      "Cached input tokens cannot exceed input tokens",
    )
  })

  it("upserts turn telemetry and aggregates by session, provider, and model", () => {
    const ledger = new UsageLedger()
    ledger.record({
      sessionId: "session-1",
      turnId: "turn-1",
      provider: "cursor-agent",
      model: "gpt-5.4",
      usage: normalizeUsage({ inputTokens: 10, outputTokens: 5, cost: { amount: 0.01, currency: "USD" } }),
    })
    ledger.record({
      sessionId: "session-1",
      turnId: "turn-2",
      provider: "cursor-agent",
      model: "gpt-5.4",
      usage: normalizeUsage({ inputTokens: 20, cachedInputTokens: 5, outputTokens: 8 }),
    })
    ledger.record({
      sessionId: "session-1",
      turnId: "turn-1",
      provider: "cursor-agent",
      model: "gpt-5.4",
      usage: normalizeUsage({ inputTokens: 12, outputTokens: 6, cost: { amount: 0.012, currency: "USD" } }),
    })

    expect(ledger.session("session-1")).toEqual({
      sessionId: "session-1",
      inputTokens: 32,
      cachedInputTokens: 5,
      outputTokens: 14,
      reasoningTokens: 0,
      totalTokens: 46,
      costMicros: 12_000,
      currency: "USD",
      reportedCostTurns: 1,
      unavailableCostTurns: 1,
      byRuntime: [{
        provider: "cursor-agent",
        model: "gpt-5.4",
        inputTokens: 32,
        cachedInputTokens: 5,
        outputTokens: 14,
        reasoningTokens: 0,
        totalTokens: 46,
        costMicros: 12_000,
        currency: "USD",
        turns: 2,
      }],
    })
  })

  it("does not combine costs reported in different currencies", () => {
    const ledger = new UsageLedger()
    ledger.record({
      sessionId: "session-1",
      turnId: "turn-1",
      provider: "grok",
      model: "grok-code",
      usage: normalizeUsage({ cost: { amount: 1, currency: "USD" } }),
    })
    expect(() => ledger.record({
      sessionId: "session-1",
      turnId: "turn-2",
      provider: "grok",
      model: "grok-code",
      usage: normalizeUsage({ cost: { amount: 1, currency: "EUR" } }),
    })).toThrow("mixed currencies")
  })
})
