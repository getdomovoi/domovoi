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

  expect(onResolve).toHaveBeenCalledWith(approval.id, "allow-once", undefined, 0)
})

// Round 4 on #545: the daemon rewrites a file card when the file it reaches
// moves, and refuses an Allow that names the card as it was. The card shows
// the file it now reaches and answers with the revision it shows.
it.each(["desktop", "web"] as const)("shows the rewritten file target on the %s card and answers with its revision", async (surface) => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const raised = snapshot.approvals[0]!
  raised.risk = "normal"
  raised.command = "Edit"
  raised.operation = "Edit a file"
  raised.affects = "The file one/file in the session worktree."
  const onResolve = vi.fn(async () => {})
  const thread = (current: typeof snapshot) => (
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={current}
      connected
      surface={surface}
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
    />
  )
  const { rerender } = render(thread(snapshot))
  const affects = () => {
    const terms = [...screen.getByRole("alert").querySelectorAll("dt")]
    return terms.find((term) => term.textContent === "Affects")?.nextElementSibling?.textContent
  }
  expect(affects()).toBe("The file one/file in the session worktree.")

  const rewritten = structuredClone(snapshot)
  rewritten.approvals[0]!.affects = "The file two/file in the session worktree."
  rewritten.approvals[0]!.revision = 1
  rerender(thread(rewritten))
  expect(affects()).toBe("The file two/file in the session worktree.")

  await user.click(screen.getByRole("button", { name: "Allow once" }))
  await user.click(screen.getByRole("button", { name: surface === "web" ? "Always here" : "Always in this project" }))
  await user.click(screen.getByRole("button", { name: "Deny" }))
  await user.type(screen.getByLabelText("Tell the agent why this command was denied"), "Not that file")
  await user.click(screen.getByRole("button", { name: "Deny with explanation" }))
  expect(onResolve.mock.calls).toEqual([
    [raised.id, "allow-once", undefined, 1],
    [raised.id, "always-project", undefined, 1],
    [raised.id, "deny-explain", "Not that file", 1],
  ])
})

function renderThread(surface: "desktop" | "web" = "desktop", risk?: "normal" | "hard-gate") {
  const snapshot = structuredClone(demoWorkspace)
  if (risk) snapshot.approvals[0]!.risk = risk
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
  expect(card.textContent).toContain("This tab holds the gate")
  expect(screen.queryByRole("button", { name: "Always in this project" })).toBeNull()
})

// Ruled by fetzy 2026-09-24, against the signed web design on this one point:
// the daemon refuses a standing rule on a hard gate, so no surface offers one.
it.each(["desktop", "web"] as const)("offers no Always on a %s hard-gate card", (surface) => {
  const approval = renderThread(surface)
  expect(approval.risk).toBe("hard-gate")
  expect(approval.execution.state).toBe("resolved")
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Always here" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Always in this project" })).toBeNull()
})

it("keeps optional explanation behind Deny instead of a fourth peer action", async () => {
  const user = userEvent.setup()
  renderThread("desktop", "normal")
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

// Ruled by fetzy 2026-09-24: a request the daemon could not resolve cannot
// become a standing rule, so no surface offers Always for it.
it.each(["desktop", "web"] as const)("offers no Always on the %s card for a request that cannot become a standing rule", (surface) => {
  const snapshot = structuredClone(demoWorkspace)
  const approval = snapshot.approvals[0]!
  approval.risk = "normal"
  approval.execution = { state: "unresolved", reason: "cwd-outside-project" }
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
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Always in this project" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Always here" })).toBeNull()
})

