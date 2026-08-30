import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { UsageLedger, normalizeProviderUsage, normalizeUsage } from "./usage.js"

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

  it("preserves provider-reported aggregate tokens without inventing a breakdown", () => {
    expect(normalizeUsage({ totalTokens: 120, cost: { amount: 0.03, currency: "USD" } })).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 120,
      costMicros: 30_000,
      currency: "USD",
      costSource: "provider-reported",
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

  it("persists turn telemetry across ledger restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-usage-"))
    const path = join(directory, "state.sqlite")
    try {
      const first = new UsageLedger(path)
      first.record({
        sessionId: "session-1",
        turnId: "turn-1",
        provider: "grok",
        model: "grok-code-fast-1",
        usage: normalizeUsage({ totalTokens: 120, cost: { amount: 0.03, currency: "USD" } }),
      })
      first.close()

      const reopened = new UsageLedger(path)
      expect(reopened.session("session-1")).toMatchObject({
        totalTokens: 120,
        costMicros: 30_000,
        currency: "USD",
        reportedCostTurns: 1,
        byRuntime: [{ provider: "grok", model: "grok-code-fast-1", turns: 1 }],
      })
      reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("normalizes Claude, Codex, and OpenCode-shaped payloads conservatively", () => {
    expect(normalizeProviderUsage({
      usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 8 },
      total_cost_usd: 0.02,
    })).toMatchObject({ inputTokens: 20, cachedInputTokens: 5, outputTokens: 8, costMicros: 20_000 })
    expect(normalizeProviderUsage({
      tokens: { input: 12, output: 4, reasoning: 2, cache: { read: 3 } },
      cost: 0.01,
    })).toMatchObject({ inputTokens: 12, cachedInputTokens: 3, reasoningTokens: 2 })
    expect(normalizeProviderUsage({ message: "no counters" })).toBeUndefined()
  })
})
