import type { SessionHistoryPage } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import type { SessionHistoryFocus } from "./session-history"
import { HistoryPanel } from "./workspace-shell"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function page(): SessionHistoryPage {
  return {
    sessionId: "session-billing",
    hasMore: false,
    items: [
      {
        id: "thread:checkpoint-7f23",
        sourceId: "checkpoint-7f23",
        sessionId: "session-billing",
        createdAt: "2026-09-08T12:51:00.000Z",
        category: "checkpoints",
        label: "7f23 · before migration",
        commit: "a".repeat(40),
      },
    ],
  }
}

type Load = ComponentProps<typeof HistoryPanel>["onLoad"]

function panel(focus: SessionHistoryFocus | undefined, onLoad: Load) {
  return (
    <HistoryPanel
      sessionId="session-billing"
      connected
      onLoad={onLoad}
      focus={focus}
    />
  )
}

const pressed = () => screen
  .getAllByRole("button", { pressed: true })
  .map((button) => button.textContent)

// The design names Checkpoints as a view of History, not a pane beside it, so
// the affordance that says Checkpoints has to land in the pane already
// filtered. Opening History with all seven filters lit is not that view.
it("opens the pane with only the checkpoints filter selected", async () => {
  const onLoad = vi.fn(async () => page())
  render(panel({ category: "checkpoints", requestId: 1 }, onLoad))
  await settle()

  expect(pressed()).toEqual(["Checkpoints"])
  expect(onLoad).toHaveBeenCalledWith(
    "session-billing",
    expect.objectContaining({ categories: ["checkpoints"] }),
    expect.anything(),
  )
})

// A deep link is pressed more than once. The second press carries the same
// category as the first, so the category alone cannot say a new request
// happened; the request id is what separates them.
it("re-applies the filter when the deep link fires again after the user widens it", async () => {
  const user = userEvent.setup()
  const onLoad = vi.fn(async () => page())
  const view = render(panel({ category: "checkpoints", requestId: 1 }, onLoad))
  await settle()

  await user.click(screen.getByRole("button", { name: "Tools" }))
  await settle()
  expect(pressed()).toEqual(["Checkpoints", "Tools"])

  view.rerender(panel({ category: "checkpoints", requestId: 2 }, onLoad))
  await settle()
  expect(pressed()).toEqual(["Checkpoints"])
})

// Nothing asked for a view, so the pane still shows every category.
it("shows every category when no focus is requested", async () => {
  const onLoad = vi.fn(async () => page())
  render(panel(undefined, onLoad))
  await settle()

  expect(pressed()).toHaveLength(9)
})

// The design draws an Everything control beside the named filters. Widening
// back out took seven clicks without it, and the pane starts wide, so nothing
// showed that the wide state had a name.
it("widens back to every category from the Everything control", async () => {
  const user = userEvent.setup()
  const onLoad = vi.fn(async () => page())
  render(panel({ category: "checkpoints", requestId: 1 }, onLoad))
  await settle()
  expect(pressed()).toEqual(["Checkpoints"])

  await user.click(screen.getByRole("button", { name: "Everything" }))
  await settle()

  expect(pressed()).toEqual([
    "Everything",
    "Turns",
    "Approvals",
    "Checkpoints",
    "Transfers",
    "Handoffs",
    "Tools",
    "Annotations",
    "Tests",
  ])
})

// Everything says whether the pane is wide, so it cannot read as selected while
// a filter is holding entries back.
it("does not show Everything as selected while one category is focused", async () => {
  const onLoad = vi.fn(async () => page())
  render(panel({ category: "checkpoints", requestId: 1 }, onLoad))
  await settle()

  expect(screen.getByRole("button", { name: "Everything" }).getAttribute("aria-pressed")).toBe("false")
})
