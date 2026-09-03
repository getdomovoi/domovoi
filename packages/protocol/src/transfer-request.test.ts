import { describe, expect, it } from "vitest"

import { sourceRefusalSchema } from "./transfer.js"
import { transferRefusalSchema } from "./transfer-preflight.js"
import { transferStreamRefusalSchema } from "./transfer-stream.js"
import {
  sessionTransferParamsSchema,
  sessionTransferRefusalMessage,
  sessionTransferResultSchema,
} from "./transfer-request.js"

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

describe("session transfer refusal messages", () => {
  it("names why the target machine refused the move", () => {
    expect(sessionTransferRefusalMessage("target-upgrade-required"))
      .toBe("That machine runs an older Domovoi and needs an upgrade first")
  })

  it("names why the source session could not be moved", () => {
    expect(sessionTransferRefusalMessage("session-turn-active"))
      .toBe("This session is mid turn, so it cannot move until the turn settles")
  })

  it("names why the arriving bytes were rejected", () => {
    expect(sessionTransferRefusalMessage("digest-mismatch"))
      .toBe("The transferred repository bytes did not match their digest, so the move was rejected")
  })

  it("covers every refusal the daemon can answer with", () => {
    const reasons = [
      ...transferRefusalSchema.options,
      ...sourceRefusalSchema.options,
      ...transferStreamRefusalSchema.options,
    ]
    for (const reason of reasons) {
      expect(sessionTransferRefusalMessage(reason).length).toBeGreaterThan(0)
    }
  })
})
