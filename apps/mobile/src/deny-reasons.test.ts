import { describe, expect, it } from "vitest"

import {
  explanationProblem,
  maximumExplanationCharacters,
  reasonChosen,
  withReason,
  withoutReason,
} from "./deny-reasons"

describe("explanationProblem", () => {
  it("refuses a denial with no reason in it", () => {
    expect(explanationProblem("   ")).toBe(
      "Write the reason the agent is given, or deny without one.",
    )
  })

  it("refuses a reason longer than the daemon takes", () => {
    const problem = explanationProblem("x".repeat(maximumExplanationCharacters + 1))
    expect(problem).toContain(String(maximumExplanationCharacters + 1))
  })

  it("takes a reason at the limit", () => {
    expect(explanationProblem("x".repeat(maximumExplanationCharacters))).toBeUndefined()
  })

  it("takes an ordinary reason", () => {
    expect(explanationProblem("Run it on staging")).toBeUndefined()
  })
})

describe("reason chips", () => {
  it("writes the first chip as the whole reason", () => {
    expect(withReason("", "Wrong environment")).toBe("Wrong environment")
  })

  it("joins a second chip onto what is already written", () => {
    expect(withReason("Wrong environment", "Run it on staging"))
      .toBe("Wrong environment. Run it on staging")
  })

  it("keeps typed text when a chip is added", () => {
    expect(withReason("Prod migrations go out on Thursday", "Run it on staging"))
      .toBe("Prod migrations go out on Thursday. Run it on staging")
  })

  it("takes a chip back out without disturbing the rest", () => {
    expect(withoutReason("Wrong environment. Run it on staging", "Wrong environment"))
      .toBe("Run it on staging")
  })

  it("knows which chips are in the reason", () => {
    const written = withReason("", "Needs a second reviewer")
    expect(reasonChosen(written, "Needs a second reviewer")).toBe(true)
    expect(reasonChosen(written, "Wrong environment")).toBe(false)
  })

  it("does not mistake a chip inside a longer sentence for the chip itself", () => {
    expect(reasonChosen("Run it on staging first", "Run it on staging")).toBe(false)
  })
})
