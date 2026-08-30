import { describe, expect, it } from "vitest"

import { classifyProviderFailure } from "./provider-failures.js"

describe("provider failure classification", () => {
  it.each([
    ["401 token expired", "authentication-expired", "sign-in"],
    ["429 rate limit exceeded", "rate-limit", "retry"],
    ["insufficient_quota", "quota-exhausted", "check-quota"],
    ["model gpt-future not found", "model-unavailable", "change-model"],
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
