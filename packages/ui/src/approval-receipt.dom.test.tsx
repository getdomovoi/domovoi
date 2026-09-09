import type { ThreadItem } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { ApprovalReceipt } from "./approval-receipt"

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

it("invents no duration, because nothing on the wire carries one", () => {
  const { container } = render(<ApprovalReceipt receipt={receipt()} />)
  // The design shows "Ran in 38s". Neither the receipt nor a run record has a
  // duration, and timing it from adjacent timestamps would be a guess.
  expect(container.textContent).not.toMatch(/\b\d+\s?(s|ms|sec|seconds|minutes)\b/i)
})
