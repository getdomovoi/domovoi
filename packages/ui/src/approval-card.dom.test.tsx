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

function renderThread(surface: "desktop" | "web" = "desktop") {
  const snapshot = structuredClone(demoWorkspace)
  render(
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      surface={surface}
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

it("uses the signed web gate wording and names the holder", () => {
  renderThread("web")
  const card = screen.getByRole("alert")
  expect(card.textContent).toContain("Approval required, hard gate")
  expect(screen.getByRole("button", { name: "Always here" })).toBeTruthy()
  expect(card.textContent).toContain("This tab holds the gate")
  expect(screen.queryByRole("button", { name: "Always in this project" })).toBeNull()
})

it("keeps optional explanation behind Deny instead of a fourth peer action", async () => {
  const user = userEvent.setup()
  renderThread()
  const weight = (name: string) => screen.getByRole("button", { name }).className
  expect(weight("Allow once")).toContain("bg-warning")
  expect(weight("Always in this project")).toContain("border-border")
  expect(weight("Deny")).toContain("border-border")
  expect(screen.queryByRole("button", { name: "Deny and explain" })).toBeNull()

  await user.click(screen.getByRole("button", { name: "Deny" }))

  expect(screen.getByLabelText("Tell the agent why this command was denied")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Deny without explanation" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Deny with explanation" })).toBeTruthy()
})

it("cancels denial explanation without deciding", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
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
    />,
  )

  await user.click(screen.getByRole("button", { name: "Deny" }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))

  expect(onResolve).not.toHaveBeenCalled()
  expect(screen.queryByLabelText("Tell the agent why this command was denied")).toBeNull()
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy()
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
