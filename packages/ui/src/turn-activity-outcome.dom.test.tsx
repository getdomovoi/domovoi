import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { TurnActivity, type ToolActivity } from "./turn-activity"

afterEach(cleanup)

// D7 (desktop v2 conversation.activity-row): the label names the turn
// (Working, Worked for N, Stopped), the step dots are coloured by outcome, and
// a step with a log opens from its whole row.

const items: ToolActivity[] = [
  { id: "read", name: "read_file", argument: "src/webhooks/handler.ts", outcome: "completed" },
  { id: "test", name: "bash", argument: "pnpm vitest run webhooks", outcome: "failed", failed: true, log: "FAIL webhooks/replay.spec.ts" },
  { id: "gate", name: "bash", argument: "pnpm prisma migrate deploy", outcome: "declined" },
  { id: "live", name: "bash", argument: "pnpm build", outcome: "running" },
]

const dotFill = (argument: string) => {
  const row = screen.getByText(argument).closest("li")!
  return row.querySelector("[data-status-dot]")!.className.split(/\s+/u).find((name) => name.startsWith("bg-"))
}

describe("the label", () => {
  it("says how long a finished turn worked, and offers the steps while closed", async () => {
    const user = userEvent.setup()
    render(<TurnActivity items={items} running={false} timing={{ kind: "worked", duration: "4m 18s" }} />)
    const row = screen.getByRole("button", { name: /^Worked for 4m 18s, show the steps/u })
    await user.click(row)
    expect(row.textContent).toContain("Worked for 4m 18s")
    expect(row.textContent).not.toContain("show the steps")
  })

  it("says Stopped for a turn that stopped", () => {
    render(<TurnActivity items={items} running={false} timing={{ kind: "stopped" }} />)
    expect(screen.getByRole("button", { name: /^Stopped/u })).toBeTruthy()
  })

  it("keeps the count when the turn's time is unknown", () => {
    render(<TurnActivity items={items} running={false} timing={{ kind: "unknown" }} />)
    expect(screen.getByRole("button", { name: /^4 tool calls, 1 failed/u })).toBeTruthy()
  })

  it("says Working while the row runs, whatever the timing says", () => {
    render(<TurnActivity items={items} running timing={{ kind: "worked", duration: "4m 18s" }} />)
    expect(screen.getByRole("button", { name: /^Working/u })).toBeTruthy()
  })
})

describe("the step dots", () => {
  it("colour each step by its outcome", async () => {
    const user = userEvent.setup()
    render(<TurnActivity items={items} running />)
    await user.click(screen.getByRole("button", { name: /^Working/u }))
    expect(dotFill("src/webhooks/handler.ts")).toBe("bg-success")
    expect(dotFill("pnpm vitest run webhooks")).toBe("bg-destructive")
    expect(dotFill("pnpm prisma migrate deploy")).toBe("bg-warning")
    expect(dotFill("pnpm build")).toBe("bg-primary")
  })

  // A call still marked running in a row whose turn is no longer running has
  // no result anyone saw.
  it("draw a step left running in a stopped row as no result", async () => {
    const user = userEvent.setup()
    render(<TurnActivity items={items} running={false} />)
    await user.click(screen.getByRole("button", { name: /^4 tool calls/u }))
    expect(dotFill("pnpm build")).toBe("bg-faint")
    // Review round 2: the design's words for it, "no result", not "running".
    const row = screen.getByText("pnpm build").closest("li")!
    expect(row.textContent).toContain("no result")
    expect(row.textContent).not.toContain("running")
  })
})

describe("a step with a log", () => {
  it("opens and closes from the whole row, by keyboard", async () => {
    const user = userEvent.setup()
    render(<TurnActivity items={items} running={false} />)
    await user.click(screen.getByRole("button", { name: /^4 tool calls/u }))
    const step = screen.getByRole("button", { name: /pnpm vitest run webhooks/u })
    expect(step.getAttribute("aria-expanded")).toBe("false")
    expect(within(step).getByText("bash")).toBeTruthy()
    step.focus()
    await user.keyboard("{Enter}")
    expect(step.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("FAIL webhooks/replay.spec.ts")).toBeTruthy()
    await user.keyboard(" ")
    expect(step.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("FAIL webhooks/replay.spec.ts")).toBeNull()
  })

  it("is the only step that is a control", async () => {
    const user = userEvent.setup()
    render(<TurnActivity items={items} running={false} />)
    await user.click(screen.getByRole("button", { name: /^4 tool calls/u }))
    expect(screen.queryByRole("button", { name: /src\/webhooks\/handler\.ts/u })).toBeNull()
  })
})
