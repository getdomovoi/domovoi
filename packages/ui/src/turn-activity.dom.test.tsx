import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it } from "vitest"

import { TurnActivity, type ToolActivity } from "./turn-activity"

afterEach(cleanup)

const items: ToolActivity[] = [
  { id: "1", name: "read", argument: "src/webhooks/handler.ts", outcome: "read 240 lines" },
  { id: "2", name: "test", argument: "pnpm vitest run replay", outcome: "1 failed", failed: true, log: "replay.spec.ts:14 expected 1 got 2" },
]

it("collapses the whole turn into one row", () => {
  render(<TurnActivity items={items} running />)
  expect(screen.getByRole("button", { name: /2 tool calls, 1 failed/ })).toBeTruthy()
  expect(screen.queryByText("src/webhooks/handler.ts")).toBeNull()
})

it("opens to the calls and closes again", async () => {
  const user = userEvent.setup()
  render(<TurnActivity items={items} running={false} />)
  await user.click(screen.getByRole("button", { name: /2 tool calls/ }))
  expect(screen.getByText("src/webhooks/handler.ts")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /2 tool calls/ }))
  expect(screen.queryByText("src/webhooks/handler.ts")).toBeNull()
})

it("keeps output behind a second click, so one failure does not flood the thread", async () => {
  const user = userEvent.setup()
  render(<TurnActivity items={items} running={false} />)
  await user.click(screen.getByRole("button", { name: /2 tool calls/ }))
  expect(screen.queryByText(/expected 1 got 2/)).toBeNull()
  await user.click(screen.getByRole("button", { name: "Output" }))
  expect(screen.getByText(/expected 1 got 2/)).toBeTruthy()
})

it("moves only while the turn is running", () => {
  const { container: live } = render(<TurnActivity items={items} running />)
  expect(live.querySelectorAll(".animate-pulse")).toHaveLength(1)
  cleanup()
  const { container: still } = render(<TurnActivity items={items} running={false} />)
  expect(still.querySelectorAll(".animate-pulse")).toHaveLength(0)
})

it("says it is working before any tool call has happened", () => {
  render(<TurnActivity items={[]} running />)
  expect(screen.getByRole("button", { name: /Working/ })).toBeTruthy()
})

it("does not claim activity for a finished turn that ran nothing", () => {
  render(<TurnActivity items={[]} running={false} />)
  expect(screen.getByRole("button", { name: /No tool calls/ })).toBeTruthy()
})
