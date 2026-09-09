import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

it("sends the selected approval-card decision", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const approval = snapshot.approvals[0]!
  const onResolve = vi.fn(async () => {})
  render(
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      onResolve={onResolve}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
      onArchiveSession={vi.fn(async () => {})}
    />,
  )

  await user.click(screen.getByRole("button", { name: "Allow once" }))

  expect(onResolve).toHaveBeenCalledWith(approval.id, "allow-once", undefined)
})

function renderThread() {
  const snapshot = structuredClone(demoWorkspace)
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
      onArchiveSession={vi.fn(async () => {})}
    />,
  )
  return snapshot.approvals[0]!
}

// The design gives the gate one decision at full weight, two outlined next to
// it, and the fourth as plain text. Four peer buttons make the person read all
// four before acting.
it("gives the gate one decision at full weight", () => {
  renderThread()
  const weight = (name: string) => screen.getByRole("button", { name }).className
  expect(weight("Allow once")).toContain("bg-warning")
  expect(weight("Always in this project")).toContain("border-border")
  expect(weight("Deny")).toContain("border-border")
  const explain = weight("Deny and explain")
  expect(explain).not.toContain("bg-warning")
  expect(explain).not.toContain("border-border")
})

it("carries the card radius the design system derives from --radius", () => {
  renderThread()
  expect(screen.getByRole("alert").className).toContain("rounded-xl")
})

// Agent and mode belong to the header line, not the facts grid. Nothing is
// dropped: the desktop shows every approval fact.
it("names the agent and mode on the header line", () => {
  const approval = renderThread()
  const card = screen.getByRole("alert")
  expect(card.textContent).toContain(`${approval.agent} · ${approval.mode}`)
  const terms = [...card.querySelectorAll("dt")].map((term) => term.textContent)
  expect(terms).not.toContain("Agent")
  expect(terms).not.toContain("Mode")
  expect(terms).toContain("Machine")
  expect(terms).toContain("Est. duration")
})
