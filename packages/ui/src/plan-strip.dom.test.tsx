import type { WorkingPlan } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { PlanStrip, currentPlanStep, queuedEditStep } from "./plan-strip"

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
  const onDiscardEdit = vi.fn(async () => {})
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

// v2 puts Edit on the strip itself. Editing happens in the expanded strip
// with the same step editor the Plan preview uses, against the structure
// revision the person was looking at.
it("edits the plan in the strip and submits against the revision it saw", async () => {
  const user = userEvent.setup()
  const onEditPlan = vi.fn(async () => {})
  render(<PlanStrip plan={planWith(steps)} onEditPlan={onEditPlan} />)
  await user.click(screen.getByRole("button", { name: "Edit the plan" }))
  const third = screen.getByRole("textbox", { name: "Step 3" })
  await user.clear(third)
  await user.type(third, "Backfill the replay log from the journal")
  await user.click(screen.getByRole("button", { name: "Save plan" }))
  expect(onEditPlan).toHaveBeenCalledWith({
    basedOnStructureRevision: 2,
    baseSteps: steps.map(({ id, text }) => ({ id, text })),
    draftSteps: [
      { id: "s1", text: "Read the webhook handler" },
      { id: "s2", text: "Add the idempotency table" },
      { id: "s3", text: "Backfill the replay log from the journal" },
    ],
  })
  expect(screen.queryByRole("textbox", { name: "Step 3" })).toBeNull()
})

it("holds Edit shut for a viewer who cannot change the plan, and says why", () => {
  render(<PlanStrip plan={planWith(steps)} onEditPlan={vi.fn(async () => {})} readOnly />)
  const edit = screen.getByRole("button", { name: "Edit the plan" }) as HTMLButtonElement
  expect(edit.disabled).toBe(true)
  expect(edit.title).toMatch(/read-only/i)
})

it("names the step a queued edit changes", () => {
  render(<PlanStrip plan={planWith(steps, {
    id: "edit-3",
    basedOnStructureRevision: 2,
    baseSteps: steps.map(({ id, text }) => ({ id, text })),
    draftSteps: [
      { id: "s1", text: "Read the webhook handler" },
      { id: "s2", text: "Add the idempotency table" },
      { id: "s3", text: "Backfill the replay log from the journal" },
    ],
    status: "queued",
    submittedAt: "2026-09-08T09:11:00.000Z",
    submittedBy: { client: "desktop", connectionId: "conn-1" },
  })} />)
  expect(screen.getByText(/Your edit to step 3 is queued\./)).toBeTruthy()
})

it("opens the plan preview from the strip", async () => {
  const user = userEvent.setup()
  const onOpenPreview = vi.fn()
  render(<PlanStrip plan={planWith(steps)} onOpenPreview={onOpenPreview} />)
  await user.click(screen.getByRole("button", { name: "Plan preview" }))
  expect(onOpenPreview).toHaveBeenCalledTimes(1)
})

it("names one changed step only, never a guess for an added, removed or multi-step edit", () => {
  const base = steps.map(({ id, text }) => ({ id, text }))
  const edit = (draftSteps: { id: string, text: string }[]) => ({
    id: "e", basedOnStructureRevision: 2, baseSteps: base, draftSteps, status: "queued" as const,
    submittedAt: "2026-09-08T09:11:00.000Z", submittedBy: { client: "desktop" as const, connectionId: "conn-1" },
  })
  expect(queuedEditStep(edit([base[0]!, { id: "s2", text: "Add the table" }, base[2]!]))).toBe(2)
  expect(queuedEditStep(edit([...base, { id: "s4", text: "Ship it" }]))).toBeUndefined()
  expect(queuedEditStep(edit([base[0]!, base[2]!]))).toBeUndefined()
  expect(queuedEditStep(edit([{ id: "s1", text: "A" }, { id: "s2", text: "B" }, base[2]!]))).toBeUndefined()
})

it("keeps the queued edit and says why when a discard is refused, then lets you try again", async () => {
  const user = userEvent.setup()
  const onDiscardEdit = vi.fn<(editId: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Daemon connection is not open"))
    .mockResolvedValueOnce(undefined)
  render(<PlanStrip plan={planWith(steps, {
    id: "edit-4", basedOnStructureRevision: 2,
    baseSteps: [{ id: "s1", text: "Read the webhook handler" }],
    draftSteps: [{ id: "s1", text: "Read it again" }],
    status: "queued", submittedAt: "2026-09-08T09:11:00.000Z", submittedBy: { client: "desktop", connectionId: "conn-1" },
  })} onDiscardEdit={onDiscardEdit} />)
  await user.click(screen.getByRole("button", { name: "Discard" }))
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(screen.getByRole("alert").textContent).toMatch(/Daemon connection is not open/)
  expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(false)
  await user.click(screen.getByRole("button", { name: "Discard" }))
  expect(onDiscardEdit).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole("alert")).toBeNull()
})

it("holds Discard shut for a read-only viewer too", () => {
  render(<PlanStrip plan={planWith(steps, {
    id: "edit-5", basedOnStructureRevision: 2,
    baseSteps: [{ id: "s1", text: "Read the webhook handler" }],
    draftSteps: [{ id: "s1", text: "Read it again" }],
    status: "queued", submittedAt: "2026-09-08T09:11:00.000Z", submittedBy: { client: "desktop", connectionId: "conn-1" },
  })} onDiscardEdit={vi.fn(async () => {})} readOnly />)
  expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true)
})
