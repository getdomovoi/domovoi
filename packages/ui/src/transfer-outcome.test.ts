import { describe, expect, it } from "vitest"
import {
  transferFailureReasonSchema,
  transferRecoveryStageSchema,
  type SessionTransferResult,
} from "@getdomovoi/protocol"

import { transferOutcomeNotice } from "./transfer-outcome.js"

type Incomplete = Extract<SessionTransferResult, { outcome: "incomplete" }>

const transferId = `transfer-${"a".repeat(32)}`

describe("transferOutcomeNotice", () => {
  it("says what to do next for every state the daemon can report", () => {
    const states: Incomplete[] = [
      { outcome: "incomplete", transferId, state: "unknown", recoveryAction: "check-status" },
      { outcome: "incomplete", transferId, state: "receiving", recoveryAction: "resume" },
      { outcome: "incomplete", transferId, state: "prepared", recoveryAction: "resume" },
      ...transferRecoveryStageSchema.options.map((stage): Incomplete => (
        { outcome: "incomplete", transferId, state: "recovering", stage, recoveryAction: "none" }
      )),
      ...transferFailureReasonSchema.options.map((reason): Incomplete => (
        { outcome: "incomplete", transferId, state: "failed", reason, recoveryAction: "retry" }
      )),
      {
        outcome: "incomplete",
        transferId,
        state: "ownership-unconfirmed",
        recoveryAction: "confirm-source-recovery",
      },
      { outcome: "incomplete", transferId, state: "ownership-conflict", recoveryAction: "none" },
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
      { outcome: "incomplete", transferId, state: "failed", reason: "resource-import-failed", recoveryAction: "retry" },
      "workshop",
    )

    expect(notice.detail).toContain("artifacts and attachments could not be imported")
  })
})
