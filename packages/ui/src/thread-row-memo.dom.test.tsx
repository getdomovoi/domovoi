import { demoWorkspace, type ThreadItem, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

const activityRenders = vi.fn()
const checkpointRenders = vi.fn()

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>()
  return {
    ...actual,
    ChevronRightIcon: (props: Record<string, unknown>) => {
      activityRenders()
      return <span data-testid="activity-chevron" {...props} />
    },
  }
})

vi.mock("./checkpoint-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checkpoint-actions.js")>()
  return {
    ...actual,
    CheckpointRestore: (props: Parameters<typeof actual.CheckpointRestore>[0]) => {
      checkpointRenders()
      return <actual.CheckpointRestore {...props} />
    },
  }
})

const { Thread } = await import("./thread")

afterEach(() => {
  cleanup()
  activityRenders.mockClear()
  checkpointRenders.mockClear()
})

function streamingSnapshots(): [WorkspaceSnapshot, WorkspaceSnapshot] {
  const before = structuredClone(demoWorkspace)
  const sessionId = before.activeSessionId!
  const tool: Extract<ThreadItem, { kind: "tool" }> = {
    id: "tool-stable",
    sessionId,
    kind: "tool" as const,
    tool: "command",
    status: "completed" as const,
    title: "pnpm test",
    createdAt: "2026-09-08T09:00:00.000Z",
  }
  const assistant: Extract<ThreadItem, { kind: "assistant" }> = {
    id: "assistant-growing",
    sessionId,
    kind: "assistant" as const,
    body: "Looking",
    createdAt: "2026-09-08T09:00:01.000Z",
  }
  const checkpoint: Extract<ThreadItem, { kind: "checkpoint" }> = {
    id: "checkpoint-stable",
    sessionId,
    kind: "checkpoint",
    label: "Before streaming",
    commit: "0123456789abcdef",
    createdAt: "2026-09-08T08:59:00.000Z",
  }
  before.thread = [checkpoint, tool, assistant]
  const after = {
    ...before,
    thread: [checkpoint, tool, { ...assistant, body: "Looking at the handler" }],
  }
  return [before, after]
}

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

it("keeps unchanged thread rows out of streaming reply renders", () => {
  const [before, after] = streamingSnapshots()
  const { rerender } = render(
    <Thread snapshot={before} connected queued={undefined} {...handlers} />,
  )
  expect(activityRenders).toHaveBeenCalledTimes(1)
  expect(checkpointRenders).toHaveBeenCalledTimes(1)

  rerender(<Thread snapshot={after} connected queued={undefined} {...handlers} />)

  expect(activityRenders).toHaveBeenCalledTimes(1)
  expect(checkpointRenders).toHaveBeenCalledTimes(1)
})
