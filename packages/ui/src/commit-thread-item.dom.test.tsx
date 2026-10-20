import type { SessionHistoryEntry, ThreadItem } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CheckpointsPanel } from "./checkpoints-panel"
import { CheckpointThreadItem } from "./thread"

afterEach(cleanup)

// Nothing commits silently (walk finding F10): the thread shows what a
// person's commit put on the session branch.
const committed: Extract<ThreadItem, { kind: "checkpoint" }> = {
  id: "checkpoint-commit", sessionId: "session-1", kind: "checkpoint", reason: "commit",
  label: "cccccccc · fix(api): retry the webhook", commit: "c".repeat(40), createdAt: "2026-10-18T12:04:00.000Z",
  committed: {
    message: "fix(api): retry the webhook\n\nThe provider retries on 5xx.",
    branch: "domovoi/session-1",
    paths: ["src/webhook.ts", "src/retry.ts"],
    pathCount: 7,
    client: "desktop",
  },
}

describe("a commit in the thread", () => {
  it("names the commit, the branch, the files and the message body, and says nothing was pushed", () => {
    render(<CheckpointThreadItem item={committed} disabled={false} onRestore={vi.fn()} />)

    expect(screen.getByText("Commit · cccccccc · fix(api): retry the webhook")).toBeTruthy()
    // The branch is set in the machine face, so the line is two elements.
    expect(screen.getByText((_, element) => element?.tagName === "P"
      && element.textContent === "Committed 7 files on domovoi/session-1. Nothing was pushed.")).toBeTruthy()
    const files = screen.getByRole("list", { name: "Files in commit cccccccc" })
    expect(files.textContent).toContain("src/webhook.ts")
    expect(files.textContent).toContain("src/retry.ts")
    expect(screen.getByText("and 5 more")).toBeTruthy()
    expect(screen.getByText("The provider retries on 5xx.")).toBeTruthy()
  })

  it("keeps an ordinary checkpoint as it was", () => {
    const { committed: _record, ...rest } = committed
    render(<CheckpointThreadItem item={{ ...rest, reason: "manual", label: "cccccccc · manual" }} disabled={false} onRestore={vi.fn()} />)

    expect(screen.getByText("Checkpoint · cccccccc · manual")).toBeTruthy()
    expect(screen.queryByText(/Nothing was pushed/u)).toBeNull()
  })

  it("names the reason in the Checkpoints tab", async () => {
    const entry: Extract<SessionHistoryEntry, { category: "checkpoints" }> = {
      id: "thread:checkpoint-commit", sourceId: committed.id, sessionId: committed.sessionId, category: "checkpoints",
      reason: "commit", label: committed.label, commit: committed.commit!, committed: committed.committed!, createdAt: committed.createdAt,
    }
    render(<CheckpointsPanel sessionId="session-1" connected onLoad={vi.fn(async () => ({ sessionId: "session-1", hasMore: false, items: [entry] }))} />)

    expect(await screen.findByText("12:04 · your commit")).toBeTruthy()
  })
})
