import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

function threadFor(snapshot: WorkspaceSnapshot) {
  return (
    <Thread
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
      onArchiveSession={vi.fn(async () => {})}
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
