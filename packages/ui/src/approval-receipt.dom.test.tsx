import { demoWorkspace, type ThreadItem } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { ApprovalReceipt } from "./approval-receipt"
import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

type Receipt = Extract<ThreadItem, { kind: "receipt" }>

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: "receipt-1",
    sessionId: "session-1",
    kind: "receipt",
    decision: "allow-once",
    operation: "pnpm prisma migrate deploy",
    checkpoint: "ckpt_7f24",
    client: "desktop",
    createdAt: "2026-09-08T14:07:00.000Z",
    ...overrides,
  }
}

it("names the recorded reference without promising the work can be undone", () => {
  render(<ApprovalReceipt receipt={receipt()} />)
  // Not a SHA, so it is shown whole: "ckpt_7f" would name something else.
  expect(screen.getByText(/Recorded against ckpt_7f24\./)).toBeTruthy()
  // The daemon takes no per-operation checkpoint, and a commit restores files
  // in the worktree only.
  expect(screen.getByText(/cannot undo effects outside it/)).toBeTruthy()
  expect(screen.queryByText(/so this is revertible/)).toBeNull()
})

it("shortens a full commit SHA but never a named reference", () => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: "a".repeat(39) + "f" })} />)
  expect(screen.getByText(/Recorded against aaaaaaa\./)).toBeTruthy()
})

it("says when there is no reference at all rather than naming one", () => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: "unavailable" })} />)
  expect(screen.getByText(/No reference was recorded for this session/)).toBeTruthy()
  expect(screen.queryByText(/Recorded against/)).toBeNull()
})

it("does not claim the agent heard a denial explanation", () => {
  render(<ApprovalReceipt receipt={receipt({ decision: "deny-explain" })} />)
  expect(screen.getByText(/the agent was told only that you denied it/)).toBeTruthy()
  expect(screen.queryByText(/The agent was told why/)).toBeNull()
})

it("says a one-off allowance saved no rule", () => {
  render(<ApprovalReceipt receipt={receipt()} />)
  expect(screen.getByText("Allowed once")).toBeTruthy()
  expect(screen.getByText(/No rule was saved, so the next request like it asks again/)).toBeTruthy()
})

it("says plainly when a decision outlives the moment", () => {
  render(<ApprovalReceipt receipt={receipt({ decision: "always-project" })} />)
  expect(screen.getByText(/saved as a rule for this project/)).toBeTruthy()
  expect(screen.getByText(/Later requests matching it run without asking/)).toBeTruthy()
})

it("claims no checkpoint for a denial, because nothing ran", () => {
  render(<ApprovalReceipt receipt={receipt({ decision: "deny" })} />)
  expect(screen.getByText("Denied")).toBeTruthy()
  expect(screen.queryByText(/revertible/)).toBeNull()
  expect(screen.getByText("Nothing ran, and no rule was saved.")).toBeTruthy()
})

it("carries a denial explanation to the reader", () => {
  render(<ApprovalReceipt receipt={receipt({ decision: "deny-explain", explanation: "Run it against staging first" })} />)
  expect(screen.getByText("Run it against staging first")).toBeTruthy()
})

it("names where the decision came from, connection included", () => {
  render(<ApprovalReceipt receipt={receipt({ connectionId: "conn-42" })} />)
  expect(screen.getByText("decided from desktop, connection conn-42")).toBeTruthy()
})

it("invents no duration when the receipt carries none", () => {
  const { container } = render(<ApprovalReceipt receipt={receipt()} />)
  // The design shows "ran in 38s". ranForMs is absent until the agent reports
  // the command complete, and timing it from adjacent timestamps would be a
  // guess.
  expect(container.textContent).not.toMatch(/\b\d+\s?(s|ms|sec|seconds|minutes)\b/i)
})

const sha = `abcdef1${"0".repeat(33)}`

// Since 5ee18251 a person's allow takes a checkpoint before the command runs
// and the receipt names it; ranForMs follows once the command completes. The
// design: meta "ckpt_7f24 · 38s", body "Checkpoint ckpt_7f24 was taken first,
// then it ran in 38s". The checkpoint is named by the same 8 characters its
// row in the thread shows ("abcdef10 · before an approved command").
it("names the checkpoint taken before the command and how long it ran", () => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: sha, ranForMs: 38_000 })} checkpointTaken />)
  expect(screen.getByText("abcdef10 · 38s")).toBeTruthy()
  expect(screen.getByText(/^Checkpoint abcdef10 was taken first, then it ran in 38s\. /u)).toBeTruthy()
  expect(screen.getByText(/cannot undo effects outside it/u)).toBeTruthy()
  expect(screen.queryByText(/Recorded against/u)).toBeNull()
})

it("names the checkpoint before the command has finished", () => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: sha })} checkpointTaken />)
  expect(screen.getByText("abcdef10")).toBeTruthy()
  expect(screen.getByText(/^Checkpoint abcdef10 was taken first\. /u)).toBeTruthy()
})

it.each([
  [900, "under 1s"],
  [69_000, "1m 09s"],
  [258_000, "4m 18s"],
  [3_720_000, "1h 02m"],
])("reads %i ms of run time as %s", (ranForMs, text) => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: sha, ranForMs })} checkpointTaken />)
  expect(screen.getByText(`abcdef10 · ${text}`)).toBeTruthy()
})

// A receipt written before the change holds the session's base commit, and
// nothing on it says which kind it is. Only a checkpoint row in the thread,
// taken at the decision, proves one was taken first.
it("claims no checkpoint the thread does not show", () => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: sha })} />)
  expect(screen.queryByText(/was taken first/u)).toBeNull()
  expect(screen.getByText(/Recorded against abcdef1\./u)).toBeTruthy()
})

it("says how long an allowed command ran with no checkpoint to name", () => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: "unavailable", ranForMs: 38_000 })} />)
  expect(screen.getByText("38s")).toBeTruthy()
  expect(screen.getByText(/^No reference was recorded for this session, .* It ran in 38s\.$/u)).toBeTruthy()
})

it("finds the checkpoint row taken at the decision in the thread", () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const sessionId = snapshot.activeSessionId!
  const decidedAt = "2026-10-02T12:00:00.000Z"
  snapshot.thread = [
    { id: "checkpoint-approved", sessionId, kind: "checkpoint", label: "abcdef10 · before an approved command", commit: sha, createdAt: decidedAt },
    { ...receipt({ sessionId, checkpoint: sha, ranForMs: 38_000 }), createdAt: decidedAt },
    // The same commit seen earlier, as an older receipt would carry it, is
    // not the checkpoint for that decision.
    { ...receipt({ id: "receipt-old", sessionId, checkpoint: "b".repeat(40) }), createdAt: "2026-10-02T11:00:00.000Z" },
    { id: "checkpoint-base", sessionId, kind: "checkpoint", label: "bbbbbbbb · session start", commit: "b".repeat(40), createdAt: "2026-10-02T10:00:00.000Z" },
  ]
  render(
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
    />,
  )
  const receipts = screen.getAllByRole("region", { name: "Decision receipt" })
  expect(receipts[0]!.textContent).toContain("Checkpoint abcdef10 was taken first, then it ran in 38s.")
  expect(receipts[1]!.textContent).not.toContain("was taken first")
  expect(receipts[1]!.textContent).toContain("Recorded against bbbbbbb.")
})
