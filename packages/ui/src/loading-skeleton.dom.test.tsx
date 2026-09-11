import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { SessionListSkeleton, ThreadSkeleton } from "./loading-skeleton"

afterEach(cleanup)

// The design's own words for this state: skeletons in the shape of what is
// coming, and a line saying which machine is being read. A shape with no
// sentence is a claim that rows are definitely coming.
it("says which machine is being read, not only that something is loading", () => {
  render(<SessionListSkeleton reading="reading mac-mini-m4" />)

  expect(screen.getByRole("status").textContent).toBe("reading mac-mini-m4")
})

it("draws the five rows the rail draws, so nothing settles upward", () => {
  const { container } = render(<SessionListSkeleton reading="reading mac-mini-m4" />)

  expect(container.querySelectorAll("[data-testid='session-list-skeleton'] > div > div")).toHaveLength(5)
})

it("gives the thread its own shape and its own line", () => {
  render(<ThreadSkeleton reading="reading mac-mini-m4" />)

  expect(screen.getByTestId("thread-skeleton")).toBeTruthy()
  expect(screen.getByRole("status").textContent).toBe("reading mac-mini-m4")
})

// A pulse is a spinner in a rectangle's clothes, and the sentence beneath
// already says something is happening.
it("does not animate the bars", () => {
  const { container } = render(<ThreadSkeleton reading="reading mac-mini-m4" />)

  expect(container.innerHTML).not.toContain("animate-")
})
