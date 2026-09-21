import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { TurnActivity } from "./turn-activity"

// The signed desktop design makes the label a function of the turn, not of the
// tool count: activityLabel is "Working" for as long as the turn runs, and only
// becomes a count once it has stopped. A running row that reads "2 tool calls"
// says the turn is over when it is not.
afterEach(cleanup)

describe("a running activity row", () => {
  const items = [
    { id: "a", name: "read_file", argument: "src/app.ts", outcome: "ok" },
    { id: "b", name: "bash", argument: "pnpm vitest", outcome: "running" },
  ]

  it("says Working while the turn runs, whatever it has already called", () => {
    render(<TurnActivity items={items} running />)
    expect(screen.getByRole("button", { name: /Working/u })).toBeTruthy()
    expect(screen.queryByText("2 tool calls")).toBeNull()
  })

  it("still opens its steps while it says Working", () => {
    render(<TurnActivity items={items} running />)
    expect(screen.getByRole("button", { name: /Working/u }).getAttribute("disabled")).toBeNull()
  })

  it("counts the calls once the turn has stopped", () => {
    render(<TurnActivity items={items} running={false} />)
    expect(screen.getByRole("button", { name: /2 tool calls/u })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Working/u })).toBeNull()
  })
})
