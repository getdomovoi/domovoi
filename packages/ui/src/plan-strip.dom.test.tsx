import type { WorkingPlan } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { PlanStrip, currentPlanStep } from "./plan-strip"

afterEach(cleanup)

function planWith(steps: WorkingPlan["steps"], pendingEdit?: WorkingPlan["pendingEdit"]): WorkingPlan {
  return {
    sessionId: "session-1",
    revision: 4,
    structureRevision: 2,
    steps,
    createdAt: "2026-09-08T09:00:00.000Z",
    updatedAt: "2026-09-08T09:10:00.000Z",
    ...(pendingEdit ? { pendingEdit } : {}),
  }
}

const steps: WorkingPlan["steps"] = [
  { id: "s1", text: "Read the webhook handler", status: "completed" },
  { id: "s2", text: "Add the idempotency table", status: "in-progress" },
  { id: "s3", text: "Backfill the replay log", status: "pending" },
]

it("shows nothing when there is no plan yet", () => {
  const { container } = render(<PlanStrip plan={undefined} />)
  expect(container.firstChild).toBeNull()
})

it("names the running step rather than the first or the last", () => {
  render(<PlanStrip plan={planWith(steps)} />)
  expect(screen.getByText("Step 2 of 3")).toBeTruthy()
  expect(screen.getByText("Add the idempotency table")).toBeTruthy()
})

it("falls forward to the next unfinished step when nothing is running", () => {
  const paused = steps.map((step) => step.status === "in-progress" ? { ...step, status: "pending" as const } : step)
  expect(currentPlanStep(planWith(paused))?.step.id).toBe("s2")
})

it("keeps the last step once everything is done", () => {
  const done = steps.map((step) => ({ ...step, status: "completed" as const }))
  expect(currentPlanStep(planWith(done))?.step.id).toBe("s3")
})

it("expands upward to the whole plan and collapses again", async () => {
  const user = userEvent.setup()
  render(<PlanStrip plan={planWith(steps)} />)
  expect(screen.queryByText("Backfill the replay log")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Expand the plan" }))
  expect(screen.getByText("Backfill the replay log")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Collapse the plan" }))
  expect(screen.queryByText("Backfill the replay log")).toBeNull()
})

it("says a queued edit applies at the next turn boundary, not to the turn in flight", () => {
  render(<PlanStrip plan={planWith(steps, {
    id: "edit-1",
    basedOnStructureRevision: 2,
    baseSteps: [{ id: "s1", text: "Read the webhook handler" }],
    draftSteps: [{ id: "s1", text: "Read the webhook handler twice" }],
    status: "queued",
    submittedAt: "2026-09-08T09:11:00.000Z",
    submittedBy: { client: "desktop", connectionId: "conn-1" },
  })} />)
  expect(screen.getByText(/applies at the next turn boundary, not to the turn in flight/)).toBeTruthy()
})

it("says plainly when an edit did not apply", async () => {
  const user = userEvent.setup()
  const onDiscardEdit = vi.fn()
  render(<PlanStrip plan={planWith(steps, {
    id: "edit-2",
    basedOnStructureRevision: 1,
    baseSteps: [{ id: "s1", text: "Read the webhook handler" }],
    draftSteps: [{ id: "s1", text: "Read it again" }],
    status: "conflicted",
    submittedAt: "2026-09-08T09:11:00.000Z",
    submittedBy: { client: "desktop", connectionId: "conn-1" },
  })} onDiscardEdit={onDiscardEdit} />)
  expect(screen.getByText(/did not apply, because the plan changed underneath it/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Discard" }))
  expect(onDiscardEdit).toHaveBeenCalledWith("edit-2")
})

it("claims no file scope for a step, because the protocol carries none", () => {
  const { container } = render(<PlanStrip plan={planWith(steps)} />)
  // The design draws a path under each step. workingPlanStepSchema has no
  // files field on purpose: paths inferred from later tool calls would be
  // post-hoc evidence presented as plan intent.
  expect(container.textContent).not.toMatch(/\.ts\b|\.tsx\b|src\//)
})
