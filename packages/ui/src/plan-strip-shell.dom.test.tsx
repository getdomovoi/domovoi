import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

function threadFor(snapshot: WorkspaceSnapshot) {
  return (
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />
  )
}

function snapshotWithPlan(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  snapshot.workingPlans = [{
    sessionId: snapshot.activeSessionId!,
    revision: 3,
    structureRevision: 2,
    steps: [
      { id: "s1", text: "Read the webhook handler", status: "completed" },
      { id: "s2", text: "Add the idempotency table", status: "in-progress" },
    ],
    createdAt: "2026-09-08T09:00:00.000Z",
    updatedAt: "2026-09-08T09:10:00.000Z",
  }]
  return snapshot
}

it("pins the running plan step above the composer", () => {
  render(threadFor(snapshotWithPlan()))
  expect(screen.getByRole("region", { name: "Working plan" })).toBeTruthy()
  expect(screen.getByText("Step 2 of 2")).toBeTruthy()
  expect(screen.getByText("Add the idempotency table")).toBeTruthy()
})

it("shows no strip for a session with no plan", () => {
  const snapshot = snapshotWithPlan()
  snapshot.workingPlans = []
  render(threadFor(snapshot))
  expect(screen.queryByRole("region", { name: "Working plan" })).toBeNull()
})

it("shows the plan for this session and not another one", () => {
  const snapshot = snapshotWithPlan()
  snapshot.workingPlans = [{ ...snapshot.workingPlans[0]!, sessionId: "some-other-session" }]
  render(threadFor(snapshot))
  expect(screen.queryByRole("region", { name: "Working plan" })).toBeNull()
})

// The strip's three actions reach the daemon and the dock through Thread.
it("routes strip edits, discards and the preview link through the thread", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const user = userEvent.setup()
  const onEditPlan = vi.fn(async () => {})
  const onDiscardPlanEdit = vi.fn(async () => {})
  const onOpenPlanPreview = vi.fn()
  const snapshot = snapshotWithPlan()
  snapshot.workingPlans[0]!.pendingEdit = {
    id: "edit-9", basedOnStructureRevision: 2,
    baseSteps: [{ id: "s1", text: "Read the webhook handler" }, { id: "s2", text: "Add the idempotency table" }],
    draftSteps: [{ id: "s1", text: "Read the webhook handler" }, { id: "s2", text: "Add the table" }],
    status: "queued", submittedAt: "2026-09-08T09:11:00.000Z", submittedBy: { client: "desktop", connectionId: "conn-1" },
  }
  render(
    <Thread
      onQueuedChange={vi.fn()} snapshot={snapshot} connected
      onResolve={vi.fn(async () => {})} onSetRuntime={vi.fn(async () => {})} onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])} onNewSession={vi.fn()} onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})} onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
      onEditPlan={onEditPlan} onDiscardPlanEdit={onDiscardPlanEdit} onOpenPlanPreview={onOpenPlanPreview}
    />,
  )
  expect(screen.getByText(/Your edit to step 2 is queued/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Discard" }))
  expect(onDiscardPlanEdit).toHaveBeenCalledWith(snapshot.activeSessionId, "edit-9")
  await user.click(screen.getByRole("button", { name: "Plan preview" }))
  expect(onOpenPlanPreview).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole("button", { name: "Edit the plan" }))
  await user.click(screen.getByRole("button", { name: "Save plan" }))
  expect(onEditPlan).toHaveBeenCalledWith(snapshot.activeSessionId, expect.objectContaining({ basedOnStructureRevision: 2 }))
})

// The strip stays for a viewer who cannot change the session, so the plan
// is still readable; only Edit and Discard shut.
it("keeps the strip readable for an archived session and shuts its edits", () => {
  const snapshot = snapshotWithPlan()
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  active.state = "archived"
  snapshot.workingPlans[0]!.pendingEdit = {
    id: "edit-10", basedOnStructureRevision: 2,
    baseSteps: [{ id: "s1", text: "Read the webhook handler" }],
    draftSteps: [{ id: "s1", text: "Read it twice" }],
    status: "queued", submittedAt: "2026-09-08T09:11:00.000Z", submittedBy: { client: "desktop", connectionId: "conn-1" },
  }
  render(
    <Thread
      onQueuedChange={vi.fn()} snapshot={snapshot} connected
      onResolve={vi.fn(async () => {})} onSetRuntime={vi.fn(async () => {})} onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])} onNewSession={vi.fn()} onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})} onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
      onEditPlan={vi.fn(async () => {})} onDiscardPlanEdit={vi.fn(async () => {})} onOpenPlanPreview={vi.fn()}
    />,
  )
  expect(screen.getByRole("region", { name: "Working plan" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Plan preview" })).toBeTruthy()
  expect((screen.getByRole("button", { name: "Edit the plan" }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true)
})
