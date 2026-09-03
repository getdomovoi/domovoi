import { describe, expect, it } from "vitest"

import { classifyProviderFailure, providerTurnCompletion } from "./provider-failures.js"

describe("provider failure classification", () => {
  it("normalizes direct and nested turn failures without retaining provider detail", () => {
    expect(providerTurnCompletion({
      status: "failed",
      reason: "429 Authorization: Bearer super-secret",
    })).toEqual({
      failed: true,
      failure: {
        kind: "rate-limit",
        action: "retry",
        message: "Provider rate limit reached",
        retryable: true,
      },
    })
    expect(providerTurnCompletion({
      turn: { status: "failed" },
      reason: "insufficient_quota",
    }).failure?.kind).toBe("quota-exhausted")
    expect(providerTurnCompletion({
      turn: { status: "failed", error: { message: "model old-model is unavailable" } },
    }).failure?.kind).toBe("model-unavailable")
    expect(providerTurnCompletion({ status: "completed" })).toEqual({ failed: false })
  })

  it.each([
    ["401 token expired", "authentication-expired", "sign-in"],
    ["authentication_failed", "authentication-expired", "sign-in"],
    ["429 rate limit exceeded", "rate-limit", "retry"],
    ["You've hit your weekly limit", "rate-limit", "retry"],
    ["insufficient_quota", "quota-exhausted", "check-quota"],
    ["Your org is out of usage · add funds to continue", "quota-exhausted", "check-quota"],
    ["model gpt-future not found", "model-unavailable", "change-model"],
    ["Your account does not have access to model claude-opus-9", "model-unavailable", "change-model"],
    ["ECONNRESET", "transport", "retry"],
  ] as const)("classifies %s", (detail, kind, action) => {
    expect(classifyProviderFailure(new Error(detail))).toMatchObject({ kind, action })
  })

  it("never returns raw provider text or embedded secrets", () => {
    const failure = classifyProviderFailure(new Error(
      "401 token=super-secret account=secret@example.com",
    ))
    expect(JSON.stringify(failure)).not.toMatch(/super-secret|secret@example/)
    expect(failure.message).toBe("Provider authentication expired")
  })

  it("uses a bounded unknown state for unfamiliar failures", () => {
    expect(classifyProviderFailure({ strange: true })).toEqual({
      kind: "unknown",
      action: "retry",
      message: "Provider request failed",
      retryable: true,
    })
  })
})
