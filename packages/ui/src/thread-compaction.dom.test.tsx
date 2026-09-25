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

function snapshotWith(...thread: ThreadItem[]): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.thread = thread
  return snapshot
}

function compaction(body: string, notice: "context-compaction" | undefined): ThreadItem {
  const row: Extract<ThreadItem, { kind: "system" }> = {
    id: "system-compaction",
    sessionId: demoWorkspace.activeSessionId!,
    kind: "system",
    body,
    createdAt: "2026-09-08T09:00:01.000Z",
    ...(notice ? { notice } : {}),
  }
  return row
}

it("marks where the provider dropped earlier turns", () => {
  render(
    <Thread
      snapshot={snapshotWith(compaction("Context compacted.", "context-compaction"))}
      connected
      queued={undefined}
      {...handlers}
    />,
  )

  const marker = screen.getByTestId("thread-compaction-marker")
  expect(marker.textContent).toContain("Context compacted")
  expect(marker.textContent).toContain("Domovoi kept the thread above")
})

it("does not dress a compaction row as a general system notice", () => {
  render(
    <Thread
      snapshot={snapshotWith(compaction("Context compacted.", "context-compaction"))}
      connected
      queued={undefined}
      {...handlers}
    />,
  )

  expect(screen.queryByText("System")).toBeNull()
})

it("leaves every other system row on the notice styling", () => {
  render(
    <Thread
      snapshot={snapshotWith(compaction("Handed off to another provider.", undefined))}
      connected
      queued={undefined}
      {...handlers}
    />,
  )

  expect(screen.queryByTestId("thread-compaction-marker")).toBeNull()
  expect(screen.getByText("System")).toBeTruthy()
})
