import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { ThreadSkeleton } from "./loading-skeleton"

afterEach(cleanup)

it("gives the thread its own shape and its own line", () => {
  render(<ThreadSkeleton reading="reading mac-mini-m4" />)

  expect(screen.getByTestId("thread-skeleton")).toBeTruthy()
  expect(screen.getByRole("status").textContent).toBe("reading mac-mini-m4")
})

// Motion is functional when it says work is in flight. A still block cannot be
// told from a real but empty row, or from a render that has hung, and the line
// beside it is equally still.
it("shimmers, because stillness would say nothing", () => {
  const { container } = render(<ThreadSkeleton reading="reading mac-mini-m4" />)

  for (const bar of container.querySelectorAll("span[aria-hidden]")) {
    expect(bar.className).toContain("skeleton-bar")
  }
})

// dv-pulse is reserved for something that wants a decision. A skeleton wants
// nothing, so the wrong keyframe here would be a wrong claim rather than a
// styling choice.
it("does not pulse, which would claim it wants a decision", () => {
  const { container } = render(<ThreadSkeleton reading="reading mac-mini-m4" />)

  expect(container.innerHTML).not.toContain("pulse")
})
