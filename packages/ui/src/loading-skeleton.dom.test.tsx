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

// Ruled Q344 A: once the first attempt has failed, nothing is being read, and
// a shimmer and a "reading" line would claim a read that is not happening. The
// skeleton stops and says what is still true: nothing has been read yet.
it("stops and says nothing has been read once the first attempt failed", () => {
  const { container } = render(<ThreadSkeleton reading="reading ws://127.0.0.1:47831/rpc" notConnectedTo="127.0.0.1:47831" />)

  expect(screen.getByRole("status").textContent).toBe("Not connected. Nothing has been read from 127.0.0.1:47831 yet.")
  const bars = container.querySelectorAll("span[aria-hidden]")
  expect(bars.length).toBeGreaterThan(0)
  for (const bar of bars) expect(bar.className).not.toContain("skeleton-bar")
})
