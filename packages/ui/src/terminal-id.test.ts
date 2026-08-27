import { describe, expect, it } from "vitest"

import { terminalIdForSession } from "./terminal-id"

describe("terminalIdForSession", () => {
  it("creates a stable protocol-sized terminal id", () => {
    expect(terminalIdForSession("session-billing")).toBe("terminal-session-billing")
    expect(terminalIdForSession("s".repeat(200))).toHaveLength(128)
  })

  it("keeps long session ids distinct beyond the truncated prefix", () => {
    const prefix = "s".repeat(160)
    expect(terminalIdForSession(`${prefix}-machine-a`)).not.toBe(
      terminalIdForSession(`${prefix}-machine-b`),
    )
  })
})
