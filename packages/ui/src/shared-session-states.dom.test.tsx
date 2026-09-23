import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { FailedReadState } from "./failed-read-state"
import { NoResultsState, NothingHasRunState } from "./shared-session-states"

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

it("keeps searched scope distinct from no results", () => {
  render(
    <NoResultsState
      query="idempotency"
      answeredMachines={["mac-mini-m4", "hetzner-cx42"]}
      unreachableMachines={["wsl-ubuntu-24"]}
      onSearchAnswered={vi.fn()}
    />,
  )

  expect(screen.getByText("Nothing matched on the two machines that answered")).toBeTruthy()
  expect(screen.getByText("wsl-ubuntu-24 did not answer", { exact: false })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Search only what answered" })).toBeTruthy()
})

it("renders the nothing-has-run state without implying a completed turn", () => {
  render(
    <NothingHasRunState
      worktree="wt-search-index"
      base="main at 8f3c1de"
      projectName="acme-api"
      starters={[{ label: "Continue from the project plan", meta: "PLAN.md" }]}
    />,
  )

  expect(screen.getByText("Nothing has run yet")).toBeTruthy()
  expect(screen.getByText("Worktree ready")).toBeTruthy()
  expect(screen.getByText("What it will do first")).toBeTruthy()
  expect(screen.getByText("Say what you want done in acme-api")).toBeTruthy()
})
