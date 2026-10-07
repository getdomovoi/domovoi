import type { Artifact, WorkingPlan } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { isWorkingPlanMirror, planSheetArtifacts, PlanSheet, WorkingPlanCard } from "./working-plan.js"

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

it("submits the baseline it opened against, not the one that arrived while typing", async () => {
  const onEdit = vi.fn(async () => {})
  const { rerender } = render(<WorkingPlanCard plan={plan()} running={false} onEditPlan={onEdit} />)

  await userEvent.click(screen.getByRole("button", { name: "Edit plan" }))
  rerender(<WorkingPlanCard
    plan={plan({
      revision: 9,
      structureRevision: 7,
      steps: [
        { id: "step-1", text: "Add a replay table", status: "completed" },
        { id: "step-9", text: "A step the agent added while you typed", status: "pending" },
      ],
    })}
    running={false}
    onEditPlan={onEdit}
  />)
  await userEvent.click(screen.getByRole("button", { name: "Save plan" }))

  expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({
    basedOnStructureRevision: 2,
    baseSteps: [
      { id: "step-1", text: "Add a replay table" },
      { id: "step-2", text: "Claim before side effects" },
      { id: "step-3", text: "Apply the migration" },
      { id: "step-4", text: "Assert exactly-once delivery" },
    ],
  }))
})

it("says why a discard failed instead of swallowing it", async () => {
  const onDiscard = vi.fn(async () => { throw new Error("Persistence is unavailable") })
  render(<WorkingPlanCard
    plan={plan({
      pendingEdit: {
        id: "edit-1",
        basedOnStructureRevision: 1,
        baseSteps: [{ id: "step-1", text: "Add a replay table" }],
        draftSteps: [{ id: "step-1", text: "Add a replay table with a claim" }],
        status: "conflicted",
        submittedAt: "2026-09-03T10:31:00.000Z",
        submittedBy: { client: "web", connectionId: "connection-2" },
      },
    })}
    running={false}
    onDiscardEdit={onDiscard}
  />)

  await userEvent.click(screen.getByRole("button", { name: "Discard edit" }))

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Persistence is unavailable"),
  )
})

it("offers no plan mutation on a read-only session", () => {
  render(<WorkingPlanCard plan={plan()} running={false} readOnly onEditPlan={vi.fn()} onDiscardEdit={vi.fn()} />)

  expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Discard edit" })).toBeNull()
})

it("marks a step that stopped for an approval the way the design does", () => {
  render(<WorkingPlanCard plan={plan()} running={false} />)

  const steps = within(screen.getByRole("list", { name: "Plan steps" })).getAllByRole("listitem")
  expect(within(steps[2]!).getByText("STOPS FOR APPROVAL")).toBeTruthy()
  expect(within(steps[3]!).queryByText("STOPS FOR APPROVAL")).toBeNull()
})

// Q350 A: a plan artifact is the document, drawn beside the working-plan card
// rather than hidden by it, and Comment on a step anchors to that document by
// a text quote. The decision row is drawn once, under both.
function planArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-plan",
    sessionId: "session-1",
    title: "Make webhook delivery exactly-once",
    type: "plan",
    revision: 2,
    content: "## Problem\n\nRetries replay the side effects.\n\n## Approach\n\nClaim the event first.",
    ...overrides,
  }
}

function sheet(extra: Partial<ComponentProps<typeof PlanSheet>> = {}) {
  return (
    <PlanSheet
      document={planArtifact()}
      workingPlan={plan()}
      running={false}
      onCarryOn={vi.fn(async () => {})}
      onComment={vi.fn(async () => {})}
      {...extra}
    />
  )
}

it("draws the plan document beside the working-plan card, with one decision row", () => {
  render(sheet())

  const document = screen.getByRole("article", { name: "Plan document" })
  expect(within(document).getByRole("heading", { name: "Make webhook delivery exactly-once" })).toBeTruthy()
  expect(within(document).getByText("Retries replay the side effects.")).toBeTruthy()
  expect(screen.getByRole("region", { name: "Working plan" })).toBeTruthy()
  expect(screen.getAllByRole("button", { name: "Looks right, carry on" })).toHaveLength(1)
  expect(screen.getByRole("button", { name: "Comment on a step" })).toBeTruthy()
})

it("comments on the words selected in the document", async () => {
  const onComment = vi.fn(async () => {})
  render(sheet({ onComment }))
  const user = userEvent.setup()
  const words = screen.getByText("Retries replay the side effects.")
  const range = document.createRange()
  range.selectNodeContents(words)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)

  await user.click(screen.getByRole("button", { name: "Comment on a step" }))
  const form = screen.getByRole("form", { name: "Comment on a step" })
  expect(within(form).getByText("Retries replay the side effects.")).toBeTruthy()
  await user.type(within(form).getByLabelText("Comment"), "Say which retries")
  await user.click(within(form).getByRole("button", { name: "Post" }))

  expect(onComment).toHaveBeenCalledWith({ quote: "Retries replay the side effects.", body: "Say which retries" })
  expect(screen.queryByRole("form", { name: "Comment on a step" })).toBeNull()
})

it("comments on a chosen step when nothing in the document is selected", async () => {
  window.getSelection()?.removeAllRanges()
  const onComment = vi.fn(async () => {})
  render(sheet({ onComment }))
  const user = userEvent.setup()

  await user.click(screen.getByRole("button", { name: "Comment on a step" }))
  const form = screen.getByRole("form", { name: "Comment on a step" })
  const steps = within(form).getByRole("radiogroup", { name: "Step" })
  // The first step not yet done is the one most likely to be in question.
  expect(within(steps).getByRole("radio", { name: "Apply the migration" }).getAttribute("aria-checked")).toBe("true")
  await user.click(within(steps).getByRole("radio", { name: "Assert exactly-once delivery" }))
  await user.type(within(form).getByLabelText("Comment"), "Cover the expiry case")
  await user.click(within(form).getByRole("button", { name: "Post" }))

  expect(onComment).toHaveBeenCalledWith({ quote: "Assert exactly-once delivery", body: "Cover the expiry case" })
})

it("keeps the comment and says why when the daemon refuses it", async () => {
  window.getSelection()?.removeAllRanges()
  const onComment = vi.fn(async () => { throw new Error("The session is read only") })
  render(sheet({ onComment }))
  const user = userEvent.setup()

  await user.click(screen.getByRole("button", { name: "Comment on a step" }))
  const form = screen.getByRole("form", { name: "Comment on a step" })
  await user.type(within(form).getByLabelText("Comment"), "Not yet")
  await user.click(within(form).getByRole("button", { name: "Post" }))

  expect(within(form).getByRole("alert").textContent).toBe("The session is read only")
  expect((within(form).getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Not yet")
})

it("says how to pick a step when there is no selection and no step list", async () => {
  window.getSelection()?.removeAllRanges()
  render(sheet({ workingPlan: undefined }))
  await userEvent.setup().click(screen.getByRole("button", { name: "Comment on a step" }))

  const form = screen.getByRole("form", { name: "Comment on a step" })
  expect(within(form).getByText("Select the words in the plan you want to comment on, then choose Comment on a step again.")).toBeTruthy()
  expect(within(form).queryByLabelText("Comment")).toBeNull()
})

it("offers no comment and no decision to a read-only client", () => {
  render(sheet({ readOnly: true }))

  expect(screen.getByRole("article", { name: "Plan document" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Comment on a step" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Looks right, carry on" })).toBeNull()
})

it("draws the same decision row under the card when there is no document", () => {
  render(sheet({ document: undefined }))

  expect(screen.queryByRole("article", { name: "Plan document" })).toBeNull()
  expect(screen.getByRole("region", { name: "Working plan" })).toBeTruthy()
  expect(screen.getAllByRole("button", { name: "Looks right, carry on" })).toHaveLength(1)
  expect(screen.getByRole("button", { name: "Comment on a step" })).toBeTruthy()
})

it("offers no comment when nothing can take one", () => {
  render(sheet({ document: undefined, onComment: undefined }))

  expect(screen.getAllByRole("button", { name: "Looks right, carry on" })).toHaveLength(1)
  expect(screen.queryByRole("button", { name: "Comment on a step" })).toBeNull()
})

// The daemon mirrors the working plan into plan-<sessionId>. Beside the card
// that mirror is the card's own text, so it is never the document; it is where
// a comment goes when no document exists. A prose plan (no steps) lands in the
// same artifact and is the document then.
it("never takes the working plan's mirror for the document", () => {
  const mirror = planArtifact({ id: "plan-session-1", title: "Working plan", revision: 9, content: "1. Add a replay table" })
  const written = planArtifact({ id: "plan-session-1-a6638da8", path: "plans/webhook.md", revision: 1 })
  const other = planArtifact({ id: "plan-session-2", sessionId: "session-2", revision: 12 })

  expect(planSheetArtifacts([mirror, written, other], "session-1", plan())).toMatchObject({
    document: { id: "plan-session-1-a6638da8" },
    commentTarget: { id: "plan-session-1-a6638da8" },
  })
  const onlyMirror = planSheetArtifacts([mirror, other], "session-1", plan())
  expect(onlyMirror.document).toBeUndefined()
  expect(onlyMirror.commentTarget?.id).toBe("plan-session-1")
  expect(onlyMirror.all.map((artifact) => artifact.id)).toEqual(["plan-session-1"])
  expect(planSheetArtifacts([mirror, written], "session-1", undefined).document?.id).toBe("plan-session-1")
  expect(isWorkingPlanMirror(written, "session-1")).toBe(false)
  expect(isWorkingPlanMirror(planArtifact({ id: "plan-session-1-0001" }), "session-1")).toBe(true)
})
