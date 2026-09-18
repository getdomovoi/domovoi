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
