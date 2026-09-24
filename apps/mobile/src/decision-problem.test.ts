import { describe, expect, it } from "vitest"

import { decisionProblem } from "./decision-problem"
import { DaemonError, DaemonNotSentError, DaemonUnconfirmedError } from "./lib/daemon"
import { DaemonTimeoutError } from "./lib/request-timeout"

describe("decisionProblem", () => {
  it("says not sent only when the frame never left", () => {
    expect(decisionProblem(new DaemonNotSentError("The daemon connection is not open")))
      .toBe("Not sent: the daemon connection is not open. The gate is still waiting.")
  })

  it("quotes the daemon's own refusal", () => {
    expect(decisionProblem(new DaemonError("Approval already resolved", -32000, undefined)))
      .toBe("The daemon refused: Approval already resolved. The gate is still waiting.")
  })

  // The daemon's own message can already end by saying the approval still
  // waits. The phone does not say it a second time.
  it("does not repeat the waiting line the daemon already gave", () => {
    const message = "Domovoi could not reach the agent, so this decision was not applied. The approval is still waiting."
    expect(decisionProblem(new DaemonError(message, -32603, undefined)))
      .toBe(`The daemon refused: ${message}`)
  })

  // Only a closing sentence counts. A message that mentions the words in
  // passing still gets the phone's own line.
  it("keeps the waiting line when the daemon mentions it only in passing", () => {
    expect(decisionProblem(new DaemonError("Checked whether The approval is still waiting. Not applied", -32000, undefined)))
      .toBe("The daemon refused: Checked whether The approval is still waiting. Not applied. The gate is still waiting.")
    expect(decisionProblem(new DaemonError("Not applied because the approval is still waiting on the agent", -32000, undefined)))
      .toBe("The daemon refused: Not applied because the approval is still waiting on the agent. The gate is still waiting.")
  })

  // The frame left. The daemon may have applied it, so the phone may not
  // claim it did not: a person who denied and reads "not sent" would deny
  // again, or one who allowed would believe nothing ran.
  it("does not claim not sent for a frame that left without an answer", () => {
    const unknown = "The daemon went away before it confirmed. The gate may or may not have been answered; when the connection returns, this screen shows which."
    expect(decisionProblem(new DaemonUnconfirmedError("The daemon closed the connection"))).toBe(unknown)
    expect(decisionProblem(new DaemonTimeoutError("approval.resolve", 10_000))).toBe(unknown)
    expect(decisionProblem(new Error("something else"))).not.toMatch(/Not sent/)
  })
})
