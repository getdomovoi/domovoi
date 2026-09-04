import { describe, expect, it } from "vitest"
import {
  transferFailureReasonSchema,
  transferRecoveryStageSchema,
  type SessionTransferResult,
} from "@getdomovoi/protocol"

import { returnTransferExplanation, transferOutcomeNotice } from "./transfer-outcome.js"

type Incomplete = Extract<SessionTransferResult, { outcome: "incomplete" }>

const transferId = `transfer-${"a".repeat(32)}`

describe("transferOutcomeNotice", () => {
  it("says what to do next for every state the daemon can report", () => {
    const states: Incomplete[] = [
      { outcome: "incomplete", transferId, state: "unknown", recoveryAction: "none" },
      { outcome: "incomplete", transferId, state: "receiving", recoveryAction: "none" },
      { outcome: "incomplete", transferId, state: "prepared", recoveryAction: "none" },
      ...transferRecoveryStageSchema.options.map((stage): Incomplete => (
        { outcome: "incomplete", transferId, state: "recovering", stage, recoveryAction: "none" }
      )),
      ...transferFailureReasonSchema.options.map((reason): Incomplete => (
        { outcome: "incomplete", transferId, state: "failed", reason, recoveryAction: "none" }
      )),
      {
        outcome: "incomplete",
        transferId,
        state: "ownership-unconfirmed",
        recoveryAction: "confirm-source-recovery",
      },
      {
        outcome: "incomplete",
        transferId,
        state: "ownership-conflict",
        recoveryAction: "keep-target-session",
      },
    ]

    for (const state of states) {
      const notice = transferOutcomeNotice(state, "workshop")

      expect(notice.title).not.toBe("")
      expect(notice.detail).toContain("workshop")
      expect(notice.detail).not.toContain("undefined")
      // The daemon already decided what the operator can do, so the notice must
      // not invent an action it did not offer or drop one it did.
      expect(notice.action).toBe(
        state.recoveryAction === "none" ? undefined : state.recoveryAction,
      )
    }
  })

  it("names the stage a partial move failed at", () => {
    const notice = transferOutcomeNotice(
      { outcome: "incomplete", transferId, state: "failed", reason: "resource-import-failed", recoveryAction: "none" },
      "workshop",
    )

    expect(notice.detail).toContain("artifacts and attachments could not be imported")
  })
})

describe("returnTransferExplanation", () => {
  it("names the origin when the target is the machine the session came from", () => {
    expect(returnTransferExplanation("machine-a", "machine-a", "workshop"))
      .toContain("came from workshop")
  })

  it("stays quiet for any other target", () => {
    expect(returnTransferExplanation("machine-a", "machine-b", "studio")).toBeUndefined()
    expect(returnTransferExplanation(undefined, "machine-b", "studio")).toBeUndefined()
  })
})
