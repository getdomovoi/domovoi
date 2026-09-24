import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { FailedReadState } from "./failed-read-state"

afterEach(cleanup)

it("renders the v2 failed-read regions in order", () => {
  render(
    <FailedReadState
      message="The daemon accepted the connection and then stopped answering mid-read."
      attempts={["Connected to mac-mini-m4", "Read stopped before the thread completed"]}
      facts={["The worktree is still on mac-mini-m4", "No partial thread is shown"]}
      retrying={false}
      onRetry={vi.fn()}
      onOpenMachine={vi.fn()}
    />,
  )

  const state = screen.getByRole("region", { name: "Could not read this session" })
  expect(state.textContent).toContain("WHAT IT TRIED")
  expect(state.textContent).toContain("What is still true")
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Open the machine" })).toBeTruthy()
})
