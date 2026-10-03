import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace } from "@getdomovoi/protocol"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { DaemonRpcError } from "./client"
import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

// J34: an allow takes a checkpoint first, and when it cannot the daemon
// refuses the decision and the gate stays. The refusal belongs on the gate it
// refused, in the daemon's words, not in a generic alert above the composer.
it("shows the daemon's refusal of a decision inside the gate card", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const refusal = "Domovoi could not take a checkpoint, so the command did not run; decide again"
  const onResolve = vi.fn()
    .mockRejectedValueOnce(new DaemonRpcError(-32603, refusal))
    .mockResolvedValueOnce(undefined)
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

  await user.click(screen.getByRole("button", { name: "Allow once" }))

  const card = screen.getByText(snapshot.approvals[0]!.command).closest("[role=alert]") as HTMLElement
  expect(within(card).getByRole("alert").textContent).toBe(refusal)
  expect(screen.queryByText("Agent request failed")).toBeNull()

  // Deciding again clears it.
  await user.click(screen.getByRole("button", { name: "Allow once" }))
  expect(within(card).queryByRole("alert")).toBeNull()
  expect(onResolve).toHaveBeenCalledTimes(2)
})

function refusalThread(onResolve: ComponentProps<typeof Thread>["onResolve"]) {
  return (current: typeof demoWorkspace) => (
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={current}
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
    />
  )
}

// The daemon answers a withdrawn or no-longer-waiting gate with an error
// before it broadcasts the snapshot that removes the gate, so the refusal
// lands in the card first. When the gate then leaves with no receipt, nobody
// decided it: the refusal moves above the composer rather than vanishing.
it("moves a card's refusal above the composer when its gate leaves without a receipt", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const refusal = "The approval was withdrawn before it could be allowed"
  const thread = refusalThread(vi.fn(async () => { throw new DaemonRpcError(-32602, refusal) }))
  const { rerender } = render(thread(snapshot))
  await user.click(screen.getByRole("button", { name: "Allow once" }))
  expect(screen.getByText(refusal)).toBeTruthy()

  const withdrawn = structuredClone(snapshot)
  withdrawn.approvals = []
  rerender(thread(withdrawn))

  expect(screen.getByText(refusal)).toBeTruthy()
  expect(screen.getByText("Agent request failed")).toBeTruthy()
})

// A refusal shown in its card belongs to that card. When the gate then leaves
// because another device answered it, the receipt says what was decided, so
// the refusal goes with the card rather than reappearing above the composer.
it("drops a card's refusal when its gate is answered elsewhere", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const refusal = "Domovoi could not take a checkpoint, so the command did not run; decide again"
  const onResolve = vi.fn().mockRejectedValueOnce(new DaemonRpcError(-32603, refusal))
  const thread = (current: typeof snapshot) => (
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={current}
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
    />
  )
  const { rerender } = render(thread(snapshot))
  await user.click(screen.getByRole("button", { name: "Allow once" }))
  expect(screen.getByText(refusal)).toBeTruthy()

  const answeredElsewhere = structuredClone(snapshot)
  const approval = answeredElsewhere.approvals[0]!
  answeredElsewhere.approvals = []
  answeredElsewhere.thread.push({
    id: `receipt-${approval.id}-phone`,
    sessionId: approval.sessionId,
    kind: "receipt",
    decision: "allow-once",
    operation: approval.operation,
    checkpoint: "unavailable",
    client: "phone",
    createdAt: "2026-10-02T12:00:00.000Z",
  })
  rerender(thread(answeredElsewhere))

  expect(screen.queryByText(refusal)).toBeNull()
  expect(screen.queryByText("Agent request failed")).toBeNull()
})

// Only a gate that leaves in the first approvals change after the refusal
// was withdrawn in answer to it. A gate that outlived a later change and
// then left with no receipt went for another reason, a pause here, and the
// refusal is about a decision nobody can make now: it goes with the card.
it("drops a card's refusal when its gate leaves later without a receipt", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const refusal = "Domovoi could not take a checkpoint, so the command did not run; decide again"
  const thread = refusalThread(vi.fn(async () => { throw new DaemonRpcError(-32603, refusal) }))
  const { rerender } = render(thread(snapshot))
  await user.click(screen.getByRole("button", { name: "Allow once" }))
  expect(screen.getByText(refusal)).toBeTruthy()

  const approval = snapshot.approvals[0]!
  const anotherGate = structuredClone(snapshot)
  anotherGate.approvals.push({ ...structuredClone(approval), id: "approval-onboarding", sessionId: "session-onboarding" })
  rerender(thread(anotherGate))
  expect(screen.getByText(refusal)).toBeTruthy()

  const paused = structuredClone(anotherGate)
  paused.approvals = paused.approvals.filter((pending) => pending.id !== approval.id)
  paused.thread.push({
    id: "thread-paused-phone",
    sessionId: approval.sessionId,
    kind: "system",
    body: "Paused by phone.",
    createdAt: "2026-10-02T12:00:00.000Z",
  })
  rerender(thread(paused))

  expect(screen.queryByText(refusal)).toBeNull()
  expect(screen.queryByText("Agent request failed")).toBeNull()
})

// A refusal can arrive after the gate has left the snapshot: the agent stopped
// waiting, the request was withdrawn or answered outside Domovoi. With no
// card to hold it, it shows with the composer's alerts, as it did before.
it("shows a refusal for a gate that has gone with the composer's alerts", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const refusal = "The agent is no longer waiting for this approval, so it was not allowed"
  let reject: (cause: unknown) => void = () => {}
  const onResolve = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  const thread = (current: typeof snapshot) => (
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={current}
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
    />
  )
  const { rerender } = render(thread(snapshot))
  await user.click(screen.getByRole("button", { name: "Allow once" }))

  const gone = structuredClone(snapshot)
  gone.approvals = []
  rerender(thread(gone))
  await act(async () => { reject(new DaemonRpcError(-32602, refusal)) })

  expect(screen.getByText(refusal)).toBeTruthy()
  expect(screen.getByText("Agent request failed")).toBeTruthy()
})

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
  // Ruled Q371 A: one label on every surface. A rule matches the execution
  // record, not a command family, so it names "this command".
  await user.click(screen.getByRole("button", { name: "Always for this command here" }))
  await user.click(screen.getByRole("button", { name: "Deny" }))
  await user.click(screen.getByRole("button", { name: "Deny with a note" }))
  await user.type(screen.getByLabelText("Note on this denial"), "Not that file")
  await user.click(screen.getByRole("button", { name: "Deny with this note" }))
  expect(onResolve.mock.calls).toEqual([
    [raised.id, "allow-once", undefined, 1],
    [raised.id, "always-project", undefined, 1],
    [raised.id, "deny", undefined, 1],
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
    />,
  )
  return snapshot.approvals[0]!
}

// A tab with no daemon connection holds nothing, so it does not say it does.
it("does not claim the tab holds the gate while disconnected", () => {
  render(
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={structuredClone(demoWorkspace)}
      connected={false}
      surface="web"
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
  expect(screen.getByRole("alert").textContent).toContain("Cannot answer this gate, the daemon is not answering.")
  expect(screen.queryByText("This tab holds the gate")).toBeNull()
})

it("uses the signed web gate wording and names the holder", () => {
  renderThread("web")
  const card = screen.getByRole("alert")
  expect(card.textContent).toContain("Approval required, hard gate")
  expect(card.textContent).toContain("This tab holds the gate")
  expect(screen.queryByRole("button", { name: /^Always/u })).toBeNull()
})

// Ruled by fetzy 2026-09-24, against the signed web design on this one point:
// the daemon refuses a standing rule on a hard gate, so no surface offers one.
it.each(["desktop", "web"] as const)("offers no Always on a %s hard-gate card", (surface) => {
  const approval = renderThread(surface)
  expect(approval.risk).toBe("hard-gate")
  expect(approval.execution.state).toBe("resolved")
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /^Always/u })).toBeNull()
})

// Ruled Q339 A: Deny decides at once, as drawn. No adapter passes a denial's
// words to the provider, so the note is a quiet secondary whose copy says the
// agent is told only that it was denied.
it("denies at once, and keeps a note as a quiet secondary that promises the agent nothing", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals[0]!.risk = "normal"
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
  const weight = (name: string) => screen.getByRole("button", { name }).className
  expect(weight("Allow once")).toContain("bg-warning")
  expect(weight("Always for this command here")).toContain("border-border")
  expect(weight("Deny")).toContain("border-border")
  expect(weight("Deny with a note")).not.toContain("border-border")

  await user.click(screen.getByRole("button", { name: "Deny" }))
  expect(onResolve).toHaveBeenCalledWith(snapshot.approvals[0]!.id, "deny", undefined, 0)
  expect(screen.queryByLabelText("Note on this denial")).toBeNull()

  await user.click(screen.getByRole("button", { name: "Deny with a note" }))
  const card = screen.getByRole("alert")
  expect(card.textContent).toContain("Kept on the receipt. The agent is told only that you denied it.")
  expect(card.textContent).not.toMatch(/tell the agent why/iu)
})

// A decision made while the daemon is gone reaches nothing, so the card says
// why and offers none until the connection is back.
it("holds every decision while the daemon is disconnected, and says why", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals[0]!.risk = "normal"
  const onResolve = vi.fn(async () => {})
  const thread = (connected: boolean) => (
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected={connected}
      onResolve={onResolve}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />
  )
  const { rerender } = render(thread(false))
  const card = screen.getByRole("alert")
  // The client knows it is disconnected, not why: an auth refusal and a lost
  // network look the same from here, so the line names no cause.
  expect(card.textContent).toContain("Cannot answer this gate while this client is disconnected from the daemon.")
  for (const name of ["Allow once", "Always for this command here", "Deny"]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true)
  }

  // A denial already being written is held too, and the words stay.
  rerender(thread(true))
  expect(screen.getByRole("alert").textContent).not.toContain("disconnected from the daemon")
  await user.click(screen.getByRole("button", { name: "Deny with a note" }))
  await user.type(screen.getByLabelText("Note on this denial"), "Not now")
  rerender(thread(false))
  expect((screen.getByRole("button", { name: "Deny with this note" }) as HTMLButtonElement).disabled).toBe(true)
  await user.type(screen.getByLabelText("Note on this denial"), "{Enter}")
  expect(onResolve).not.toHaveBeenCalled()
  expect((screen.getByLabelText("Note on this denial") as HTMLInputElement).value).toBe("Not now")
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

  await user.click(screen.getByRole("button", { name: "Deny with a note" }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))

  expect(onResolve).not.toHaveBeenCalled()
  expect(screen.queryByLabelText("Note on this denial")).toBeNull()
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
    />,
  )
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /^Always/u })).toBeNull()
})

