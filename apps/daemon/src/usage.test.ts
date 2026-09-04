import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

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

  it("keeps context occupancy only when the provider reports a valid pair", () => {
    expect(normalizeUsage({
      contextTokens: 128_000,
      contextWindowTokens: 200_000,
    })).toMatchObject({ contextTokens: 128_000, contextWindowTokens: 200_000 })
    expect(normalizeUsage({ contextTokens: 128_000 })).not.toHaveProperty("contextTokens")
    expect(normalizeUsage({ contextWindowTokens: 200_000 })).not.toHaveProperty("contextWindowTokens")
    expect(normalizeUsage({
      contextTokens: 200_001,
      contextWindowTokens: 200_000,
    })).not.toHaveProperty("contextTokens")
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

  it("keeps context within one turn but never carries it into another runtime or turn", () => {
    const ledger = new UsageLedger()
    ledger.record({
      sessionId: "session-1",
      turnId: "turn-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.6-sol",
      usage: normalizeUsage({ contextTokens: 150_000, contextWindowTokens: 200_000 }),
    })
    ledger.record({
      sessionId: "session-1",
      turnId: "turn-2",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.6-sol",
      usage: normalizeUsage({ contextTokens: 90_000, contextWindowTokens: 200_000 }),
    })
    ledger.record({
      sessionId: "session-1",
      turnId: "turn-2",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.6-sol",
      usage: normalizeUsage({ inputTokens: 4, outputTokens: 2 }),
    })

    expect(ledger.session("session-1", {
      provider: "codex",
      model: "gpt-5.6-sol",
      threadId: "thread-1",
    })).toMatchObject({ contextTokens: 90_000, contextWindowTokens: 200_000 })
    for (const active of [
      { provider: "claude-code", model: "claude-opus-5", threadId: "claude-thread-1" },
      { provider: "codex", model: "gpt-5.5", threadId: "thread-1" },
      { provider: "codex", model: "gpt-5.6-sol", threadId: "thread-2" },
    ]) {
      expect(ledger.session("session-1", active)).not.toHaveProperty("contextTokens")
    }

    ledger.record({
      sessionId: "session-1",
      turnId: "turn-3",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.6-sol",
      usage: normalizeUsage({ inputTokens: 4, outputTokens: 2 }),
    })
    expect(ledger.session("session-1", {
      provider: "codex",
      model: "gpt-5.6-sol",
      threadId: "thread-1",
    })).not.toHaveProperty("contextTokens")
    ledger.close()
  })

  it("exports exact turn rows without provider thread state and replaces them atomically", () => {
    const source = new UsageLedger()
    source.record({
      sessionId: "session-1",
      turnId: "turn-1",
      threadId: "provider-thread-secret",
      provider: "claude-code",
      model: "claude-opus-5",
      usage: normalizeUsage({
        inputTokens: 20,
        cachedInputTokens: 5,
        outputTokens: 8,
        contextTokens: 64_000,
        contextWindowTokens: 200_000,
        cost: { amount: 0.02, currency: "USD" },
      }),
    })
    const transferred = source.transferSession("session-1")
    expect(transferred).toEqual([{
      turnId: "turn-1",
      provider: "claude-code",
      model: "claude-opus-5",
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 8,
      reasoningTokens: 0,
      totalTokens: 28,
      contextTokens: 64_000,
      contextWindowTokens: 200_000,
      costSource: "provider-reported",
      costMicros: 20_000,
      currency: "USD",
    }])
    expect(JSON.stringify(transferred)).not.toContain("provider-thread-secret")

    const target = new UsageLedger()
    target.record({
      sessionId: "session-1",
      turnId: "stale-turn",
      provider: "codex",
      model: "gpt-5.6-sol",
      usage: normalizeUsage({ inputTokens: 1 }),
    })
    target.replaceTransferredSession("session-1", transferred)
    expect(target.transferSession("session-1")).toEqual(transferred)
    expect(target.session("session-1")).toMatchObject({
      totalTokens: 28,
      contextTokens: 64_000,
      contextWindowTokens: 200_000,
      byRuntime: [{ provider: "claude-code", model: "claude-opus-5", turns: 1 }],
    })
    source.close()
    target.close()
  })

  it("drops stale cost fields from an unavailable row before transfer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-usage-stale-cost-"))
    const path = join(directory, "state.sqlite")
    try {
      const ledger = new UsageLedger(path)
      ledger.record({
        sessionId: "session-1",
        turnId: "turn-1",
        provider: "claude-code",
        model: "claude-opus-5",
        usage: normalizeUsage({
          inputTokens: 4,
          cost: { amount: 0.01, currency: "USD" },
        }),
      })
      ledger.close()
      const database = new DatabaseSync(path)
      database.prepare(`
        UPDATE provider_usage SET cost_source = 'unavailable'
        WHERE session_id = 'session-1' AND turn_id = 'turn-1'
      `).run()
      database.close()

      const reopened = new UsageLedger(path)
      expect(reopened.transferSession("session-1")).toEqual([{
        turnId: "turn-1",
        provider: "claude-code",
        model: "claude-opus-5",
        inputTokens: 4,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 4,
        costSource: "unavailable",
      }])
      expect(reopened.session("session-1")).toMatchObject({
        costMicros: 0,
        reportedCostTurns: 0,
        unavailableCostTurns: 1,
      })
      expect(reopened.session("session-1")).not.toHaveProperty("currency")
      reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")("keeps usage telemetry readable only by the owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-usage-permissions-"))
    const path = join(directory, "usage.sqlite")
    try {
      const ledger = new UsageLedger(path)
      ledger.close()
      await chmod(path, 0o666)
      const reopened = new UsageLedger(path)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("persists turn telemetry across ledger restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-usage-"))
    const path = join(directory, "state.sqlite")
    try {
      const first = new UsageLedger(path)
      first.record({
        sessionId: "session-1",
        turnId: "turn-1",
        threadId: "thread-1",
        provider: "grok",
        model: "grok-code-fast-1",
        usage: normalizeUsage({
          totalTokens: 120,
          contextTokens: 64_000,
          contextWindowTokens: 128_000,
          cost: { amount: 0.03, currency: "USD" },
        }),
      })
      first.close()

      const reopened = new UsageLedger(path)
      expect(reopened.session("session-1", {
        provider: "grok",
        model: "grok-code-fast-1",
        threadId: "thread-1",
      })).toMatchObject({
        totalTokens: 120,
        contextTokens: 64_000,
        contextWindowTokens: 128_000,
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

  it("adds context occupancy columns to an existing usage database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-usage-migration-"))
    const path = join(directory, "state.sqlite")
    try {
      const legacy = new DatabaseSync(path)
      legacy.exec(`
        CREATE TABLE provider_usage (
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          cached_input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          cost_source TEXT NOT NULL,
          cost_micros INTEGER,
          currency TEXT,
          PRIMARY KEY (session_id, turn_id)
        );
      `)
      legacy.close()

      const ledger = new UsageLedger(path)
      ledger.record({
        sessionId: "session-1",
        turnId: "turn-1",
        threadId: "thread-1",
        provider: "claude-code",
        model: "sonnet",
        usage: normalizeUsage({ contextTokens: 32_000, contextWindowTokens: 200_000 }),
      })
      expect(ledger.session("session-1", {
        provider: "claude-code",
        model: "sonnet",
        threadId: "thread-1",
      })).toMatchObject({ contextTokens: 32_000, contextWindowTokens: 200_000 })
      ledger.close()
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
    expect(normalizeProviderUsage({ usage: { total_tokens: 144 } })).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 144,
      costSource: "unavailable",
    })
    expect(normalizeProviderUsage({ usage: { totalTokens: 145 } })).toMatchObject({ totalTokens: 145 })
    expect(normalizeProviderUsage({ tokens: { total: 146 } })).toMatchObject({ totalTokens: 146 })
    expect(normalizeProviderUsage({
      usage: {
        inputTokens: 120,
        outputTokens: 8,
        reasoningOutputTokens: 5,
        totalTokens: 128,
      },
    })).toMatchObject({
      inputTokens: 120,
      outputTokens: 3,
      reasoningTokens: 5,
      totalTokens: 128,
    })
    expect(() => normalizeProviderUsage({ usage: { input_tokens: 10, total_tokens: 9 } })).toThrow(
      "at least as large as known tokens",
    )
    expect(normalizeProviderUsage({ message: "no counters" })).toBeUndefined()
  })
})
