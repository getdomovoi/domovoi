import type { WorkingPlan } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { WorkingPlanCard } from "./working-plan.js"

afterEach(cleanup)

function plan(overrides: Partial<WorkingPlan> = {}): WorkingPlan {
  return {
    sessionId: "session-1",
    revision: 4,
    structureRevision: 2,
    steps: [
      { id: "step-1", text: "Add a replay table", status: "completed" },
      { id: "step-2", text: "Claim before side effects", status: "completed" },
      { id: "step-3", text: "Apply the migration", status: "in-progress", blocker: { kind: "approval", approvalId: "approval-1" } },
      { id: "step-4", text: "Assert exactly-once delivery", status: "pending" },
    ],
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:30:00.000Z",
    ...overrides,
  }
}

it("counts the steps and marks each one the way the design does", () => {
  render(<WorkingPlanCard plan={plan()} running={false} />)

  expect(screen.getByText("4 steps")).toBeTruthy()
  const steps = within(screen.getByRole("list", { name: "Plan steps" })).getAllByRole("listitem")
  expect(within(steps[0]!).getByText("✓")).toBeTruthy()
  expect(within(steps[3]!).getByText("4")).toBeTruthy()
})

it("says a step is waiting on an approval rather than only in progress", () => {
  render(<WorkingPlanCard plan={plan()} running={false} />)

  const steps = within(screen.getByRole("list", { name: "Plan steps" })).getAllByRole("listitem")
  expect(within(steps[2]!).getByText("waiting")).toBeTruthy()
})

it("pins the plan while a turn is running", () => {
  render(<WorkingPlanCard plan={plan()} running />)

  expect(screen.getByText("pinned while running")).toBeTruthy()
})

it("shows a queued edit as waiting for the turn boundary", () => {
  render(<WorkingPlanCard plan={plan({
    pendingEdit: {
      id: "edit-1",
      basedOnStructureRevision: 2,
      baseSteps: [{ id: "step-1", text: "Add a replay table" }],
      draftSteps: [{ id: "step-1", text: "Add a replay table with a unique claim" }],
      status: "queued",
      submittedAt: "2026-09-03T10:31:00.000Z",
      submittedBy: { client: "desktop", connectionId: "connection-1" },
    },
  })} running />)

  expect(screen.getByRole("status", { name: "Pending plan edit" }).textContent)
    .toMatch(/applies at the next turn boundary/iu)
})

it("keeps a conflicted edit visible with what it was based on", () => {
  render(<WorkingPlanCard plan={plan({
    pendingEdit: {
      id: "edit-1",
      basedOnStructureRevision: 1,
      baseSteps: [{ id: "step-1", text: "Add a replay table" }],
      draftSteps: [{ id: "step-1", text: "Add a replay table with a unique claim" }],
      status: "conflicted",
      submittedAt: "2026-09-03T10:31:00.000Z",
      submittedBy: { client: "web", connectionId: "connection-2" },
    },
  })} running={false} />)

  const conflict = within(screen.getByRole("status", { name: "Pending plan edit" }))
  expect(conflict.getByText(/did not apply/iu)).toBeTruthy()
  expect(conflict.getByText("Add a replay table with a unique claim")).toBeTruthy()
})

it("says nothing at all when a session has no plan", () => {
  render(<WorkingPlanCard plan={undefined} running={false} />)

  expect(screen.queryByRole("list", { name: "Plan steps" })).toBeNull()
})
