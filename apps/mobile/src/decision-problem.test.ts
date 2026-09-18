import { describe, expect, it } from "vitest"

import { decisionProblem } from "./decision-problem"
import { DaemonError } from "./lib/daemon"
import { DaemonTimeoutError } from "./lib/request-timeout"

describe("decisionProblem", () => {
  it("names a closed socket as not sent, with the gate still waiting", () => {
    expect(decisionProblem(new Error("The daemon connection is not open")))
      .toBe("Not sent: the daemon connection is not open. The gate is still waiting.")
  })

  it("names a timeout as the daemon not answering, not as a refusal", () => {
    expect(decisionProblem(new DaemonTimeoutError("approval.resolve", 10_000)))
      .toBe("Not sent: the daemon did not answer in time. The gate is still waiting.")
  })

  it("quotes the daemon's own refusal", () => {
    expect(decisionProblem(new DaemonError("Approval already resolved", -32000, undefined)))
      .toBe("The daemon refused: Approval already resolved. The gate is still waiting.")
  })
})
