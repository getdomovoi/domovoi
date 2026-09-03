import type { WorkingPlan } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

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

it("invites a first step instead of showing an empty list", () => {
  render(<WorkingPlanCard plan={plan({ revision: 1, structureRevision: 0, steps: [] })} running={false} />)

  expect(screen.queryByRole("list", { name: "Plan steps" })).toBeNull()
  expect(screen.getByText(/no steps yet/iu)).toBeTruthy()
  expect(screen.getByText("0 steps")).toBeTruthy()
})

it("sends the whole structure it edited, against the revision it was based on", async () => {
  const onEdit = vi.fn(async () => {})
  render(<WorkingPlanCard plan={plan()} running={false} onEditPlan={onEdit} />)

  await userEvent.click(screen.getByRole("button", { name: "Edit plan" }))
  const first = screen.getByRole("textbox", { name: "Step 1" })
  await userEvent.clear(first)
  await userEvent.type(first, "Add a replay table with a unique claim")
  await userEvent.click(screen.getByRole("button", { name: "Save plan" }))

  expect(onEdit).toHaveBeenCalledWith({
    basedOnStructureRevision: 2,
    baseSteps: [
      { id: "step-1", text: "Add a replay table" },
      { id: "step-2", text: "Claim before side effects" },
      { id: "step-3", text: "Apply the migration" },
      { id: "step-4", text: "Assert exactly-once delivery" },
    ],
    draftSteps: [
      { id: "step-1", text: "Add a replay table with a unique claim" },
      { id: "step-2", text: "Claim before side effects" },
      { id: "step-3", text: "Apply the migration" },
      { id: "step-4", text: "Assert exactly-once delivery" },
    ],
  })
})

it("adds a step without an id so the daemon assigns one", async () => {
  const onEdit = vi.fn(async () => {})
  render(<WorkingPlanCard plan={plan({ revision: 1, structureRevision: 0, steps: [] })} running={false} onEditPlan={onEdit} />)

  await userEvent.click(screen.getByRole("button", { name: "Edit plan" }))
  await userEvent.click(screen.getByRole("button", { name: "Add step" }))
  await userEvent.type(screen.getByRole("textbox", { name: "Step 1" }), "Write the first step")
  await userEvent.click(screen.getByRole("button", { name: "Save plan" }))

  expect(onEdit).toHaveBeenCalledWith({
    basedOnStructureRevision: 0,
    baseSteps: [],
    draftSteps: [{ text: "Write the first step" }],
  })
})

it("discards a conflicted edit by its id", async () => {
  const onDiscard = vi.fn(async () => {})
  render(<WorkingPlanCard
    plan={plan({
      pendingEdit: {
        id: "edit-1",
        basedOnStructureRevision: 1,
        baseSteps: [{ id: "step-1", text: "Add a replay table" }],
        draftSteps: [{ id: "step-1", text: "Add a replay table with a unique claim" }],
        status: "conflicted",
        submittedAt: "2026-09-03T10:31:00.000Z",
        submittedBy: { client: "web", connectionId: "connection-2" },
      },
    })}
    running={false}
    onDiscardEdit={onDiscard}
  />)

  await userEvent.click(screen.getByRole("button", { name: "Discard edit" }))

  expect(onDiscard).toHaveBeenCalledWith("edit-1")
})

it("offers no editing to a client that cannot edit", () => {
  render(<WorkingPlanCard plan={plan()} running={false} />)

  expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull()
})

it("keeps the draft and says why when the daemon refuses the edit", async () => {
  const onEdit = vi.fn(async () => { throw new Error("Session is archived and read-only") })
  render(<WorkingPlanCard plan={plan()} running={false} onEditPlan={onEdit} />)

  await userEvent.click(screen.getByRole("button", { name: "Edit plan" }))
  const first = screen.getByRole("textbox", { name: "Step 1" })
  await userEvent.clear(first)
  await userEvent.type(first, "Add a replay table with a unique claim")
  await userEvent.click(screen.getByRole("button", { name: "Save plan" }))

  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Session is archived"))
  expect(screen.getByRole("textbox", { name: "Step 1" })).toHaveProperty("value", "Add a replay table with a unique claim")
})

it("leaves edit mode once the daemon accepts the edit", async () => {
  const onEdit = vi.fn(async () => {})
  render(<WorkingPlanCard plan={plan()} running={false} onEditPlan={onEdit} />)

  await userEvent.click(screen.getByRole("button", { name: "Edit plan" }))
  await userEvent.click(screen.getByRole("button", { name: "Save plan" }))

  expect(await screen.findByRole("button", { name: "Edit plan" })).toBeTruthy()
  expect(screen.queryByRole("alert")).toBeNull()
})
