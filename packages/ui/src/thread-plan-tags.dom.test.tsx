import { demoWorkspace, type ThreadItem, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./thread"

afterEach(cleanup)

const handlers = {
  onQueuedChange: vi.fn(),
  onResolve: vi.fn(async () => {}),
  onSetRuntime: vi.fn(async () => {}),
  onForkSession: vi.fn(async () => {}),
  onListModels: vi.fn(async () => []),
  onNewSession: vi.fn(),
  onSend: vi.fn(async () => {}),
  onCheckpoint: vi.fn(async () => {}),
  onRestoreCheckpoint: vi.fn(async () => {}),
  onPauseSession: vi.fn(async () => {}),
}

function snapshotWithReply(body: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const assistant: Extract<ThreadItem, { kind: "assistant" }> = {
    id: "assistant-plan",
    sessionId: snapshot.activeSessionId!,
    kind: "assistant",
    body,
    createdAt: "2026-09-08T09:00:01.000Z",
  }
  snapshot.thread = [assistant]
  return snapshot
}

it("hides plan wrapper tags while a plan streams in", () => {
  render(
    <Thread
      snapshot={snapshotWithReply("Plan ready.\n<proposed_plan>\n## Steps\n\n1. Read the schema")}
      connected
      queued={undefined}
      {...handlers}
    />,
  )

  expect(screen.getByText("Plan ready.")).toBeTruthy()
  expect(screen.getByRole("heading", { name: "Steps" })).toBeTruthy()
  expect(screen.getByRole("listitem").textContent).toBe("Read the schema")
  expect(document.body.textContent).not.toContain("proposed_plan")
})

it("keeps prose out of the plan body once the closing tag arrives", () => {
  render(
    <Thread
      snapshot={snapshotWithReply("Plan ready.\n<proposed_plan>\n- Read the schema\n</proposed_plan>\nLet me know what to refine.")}
      connected
      queued={undefined}
      {...handlers}
    />,
  )

  expect(document.body.textContent).not.toContain("proposed_plan")
  const item = screen.getByText("Read the schema")
  expect(item.textContent).toBe("Read the schema")
})
