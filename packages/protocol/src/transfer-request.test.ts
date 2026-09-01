import { describe, expect, it } from "vitest"

import { sessionTransferParamsSchema, sessionTransferResultSchema } from "./transfer-request.js"

describe("session transfer request", () => {
  it("names the session and the machine it should move to", () => {
    expect(sessionTransferParamsSchema.safeParse({
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
    }).success).toBe(true)
  })

  it("refuses a target that is not a machine", () => {
    expect(sessionTransferParamsSchema.safeParse({
      sessionId: "session-1",
      targetMachineId: "studio",
      client: "desktop",
    }).success).toBe(false)
  })

  it("reports where a moved session now lives", () => {
    expect(sessionTransferResultSchema.safeParse({
      outcome: "succeeded",
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "c".repeat(40),
    }).success).toBe(true)
  })

  it("reports a refusal with the reason it was refused", () => {
    expect(sessionTransferResultSchema.safeParse({
      outcome: "refused",
      reason: "target-unreachable",
    }).success).toBe(true)
  })

  it("reports a transfer that broke without inventing a reason", () => {
    expect(sessionTransferResultSchema.safeParse({ outcome: "failed" }).success).toBe(true)
    expect(sessionTransferResultSchema.safeParse({
      outcome: "failed",
      reason: "target-unreachable",
    }).success).toBe(false)
  })
})
