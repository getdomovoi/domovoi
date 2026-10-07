import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace } from "@getdomovoi/protocol"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { ApprovalCard } from "./approval-card"
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

// While the answer is out, the card says so, so locked buttons are not a
// mystery, and says nothing once the daemon has answered.
it("says the decision is being sent while it is in flight", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  let settle: () => void = () => {}
  const onResolve = vi.fn(() => new Promise<void>((done) => { settle = done }))
  render(refusalThread(onResolve)(snapshot))

  expect(screen.queryByText("Sending your decision")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Allow once" }))
  expect(screen.getByRole("alert").textContent).toContain("Sending your decision")
  await act(async () => { settle() })
  expect(screen.queryByText("Sending your decision")).toBeNull()
})

// Two presses can land before React renders the first one's lock, as a held
// key repeating does. The second must not send another decision.
it("sends one decision for two presses that land before a render", async () => {
  const snapshot = structuredClone(demoWorkspace)
  const onResolve = vi.fn(() => new Promise<void>(() => {}))
  render(refusalThread(onResolve)(snapshot))
  const allow = screen.getByRole("button", { name: "Allow once" })

  await act(async () => {
    allow.click()
    allow.click()
  })

  expect(onResolve).toHaveBeenCalledTimes(1)
})

// Deny decides on the first press. A second press, or a double click, must
// not send a second decision, and must never land on the next gate when it
// takes the same place on screen before the first answer is back.
it("sends one decision per gate, and none to the next gate while one is in flight", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const first = snapshot.approvals[0]!
  first.risk = "normal"
  const second = { ...structuredClone(first), id: "approval-second", command: "rm -rf build", operation: "Remove the build directory" }
  let settle: () => void = () => {}
  const onResolve = vi.fn(() => new Promise<void>((done) => { settle = done }))
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

  await user.dblClick(screen.getByRole("button", { name: "Deny" }))
  expect(onResolve).toHaveBeenCalledTimes(1)
  expect(onResolve).toHaveBeenCalledWith(first.id, "deny", undefined, first.revision)

  // The next gate arrives before the first answer is back.
  const next = structuredClone(snapshot)
  next.approvals = [second]
  rerender(thread(next))
  expect(screen.getByText("rm -rf build")).toBeTruthy()
  const deny = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement
  expect(deny.disabled).toBe(true)
  fireEvent.click(deny)
  expect(onResolve).toHaveBeenCalledTimes(1)

  await act(async () => { settle() })
  expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false)
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
    // The desktop draws the facts behind a disclosure; open it if a fact is
    // hidden. The web card has none and shows them all.
    const open = screen.queryByRole("button", { name: "What does this touch?" })
    if (open) fireEvent.click(open)
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
  // Ruled Q371 A: one label on desktop and web. A rule matches the execution
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
  expect(screen.getByRole("alert").textContent).toContain("Cannot answer this gate while this client is disconnected from the daemon.")
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
  // The design's weights: Allow once is the one filled button, Always and
  // Deny are outlined in the gate's own border, and the note is a quiet
  // ghost with no outline.
  const weight = (name: string) => screen.getByRole("button", { name }).className
  expect(weight("Allow once")).toContain("bg-warning")
  expect(weight("Always for this command here")).toContain("border-warn-border")
  expect(weight("Deny")).toContain("border-warn-border")
  expect(weight("Deny with a note")).not.toContain("border-warn-border")

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
  expect(terms).toContain("Estimated")
})

// S3.10h: the desktop card is the drawn card. Its header says what it wants
// from the reader. The design draws no Hard gate badge there, so the risk
// rides the meta line rather than leaving the card.
it("heads the desktop gate Waiting on your decision, with a hard gate named on the meta line", () => {
  const approval = renderThread("desktop", "hard-gate")
  const card = screen.getByRole("alert")
  expect(card.textContent).toContain("Waiting on your decision")
  expect(card.textContent).not.toContain("Approval required")
  expect(card.textContent).toContain(`${approval.agent} · ${approval.mode} · hard gate`)
  cleanup()

  const normal = renderThread("desktop", "normal")
  const plain = screen.getByRole("alert")
  expect(plain.textContent).toContain(`${normal.agent} · ${normal.mode}`)
  expect(plain.textContent).not.toContain("hard gate")
})

// The design folds the facts under the decisions behind What does this
// touch?. Ruled Q7 B (2026-10-06): the disclosure starts open, so no fact
// sits behind a click: for a file edit the command reads only the tool's
// name and Affects is the line that names the file.
it("draws the desktop facts under the decisions, behind a disclosure that starts open", async () => {
  const user = userEvent.setup()
  const approval = renderThread("desktop", "normal")
  const card = screen.getByRole("alert")
  const hide = within(card).getByRole("button", { name: "Hide what this touches" })
  expect(hide.getAttribute("aria-expanded")).toBe("true")
  const facts = card.querySelector("dl")!
  expect(hide.getAttribute("aria-controls")).toBe(facts.id)
  expect([...facts.querySelectorAll("dt")].map((term) => term.textContent))
    .toEqual(["Machine", "Working dir", "Affects", "Network", "Estimated"])
  for (const value of [approval.machine, approval.directory, approval.affects, approval.network, approval.estimatedDuration]) {
    expect(within(facts).getByText(value)).toBeTruthy()
  }
  const allow = within(card).getByRole("button", { name: "Allow once" })
  expect(allow.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  await user.click(hide)
  // Folded, not removed: the control's aria-controls still names it.
  expect(facts.hidden).toBe(true)
  const show = within(card).getByRole("button", { name: "What does this touch?" })
  expect(show.getAttribute("aria-expanded")).toBe("false")
  expect(show.getAttribute("aria-controls")).toBe(facts.id)
  await user.click(show)
  expect(facts.hidden).toBe(false)
  expect(within(card).getByText(approval.affects)).toBeTruthy()
})

// Folding is a choice about the facts the card showed. When the daemon
// revises the gate, the decision would answer facts the reader has not seen,
// so the facts open again on the new revision.
it("opens folded facts again when the daemon revises the gate", async () => {
  const user = userEvent.setup()
  const approval = structuredClone(demoWorkspace).approvals[0]!
  approval.risk = "normal"
  approval.affects = "The file one/file in the session worktree."
  const { container, rerender } = render(<ApprovalCard approval={approval} onResolve={vi.fn()} surface="desktop" connected />)
  const facts = () => container.querySelector("dl")!
  await user.click(screen.getByRole("button", { name: "Hide what this touches" }))
  expect(facts().hidden).toBe(true)

  // The same revision redrawn stays folded.
  rerender(<ApprovalCard approval={structuredClone(approval)} onResolve={vi.fn()} surface="desktop" connected />)
  expect(screen.getByRole("button", { name: "What does this touch?" })).toBeTruthy()
  expect(facts().hidden).toBe(true)

  const revised = { ...structuredClone(approval), revision: approval.revision + 1, affects: "The file two/file in the session worktree." }
  rerender(<ApprovalCard approval={revised} onResolve={vi.fn()} surface="desktop" connected />)
  expect(screen.getByRole("button", { name: "Hide what this touches" }).getAttribute("aria-expanded")).toBe("true")
  expect(facts().hidden).toBe(false)
  expect(within(facts()).getByText("The file two/file in the session worktree.")).toBeTruthy()
})

// Writing a note does not take the facts away: the disclosure stays beside
// the note's controls, and the note survives a fold and an unfold.
it("keeps the facts disclosure while a denial note is written", async () => {
  const user = userEvent.setup()
  const approval = structuredClone(demoWorkspace).approvals[0]!
  render(<ApprovalCard approval={approval} onResolve={vi.fn()} surface="desktop" connected />)
  await user.click(screen.getByRole("button", { name: "Deny with a note" }))
  await user.type(screen.getByLabelText("Note on this denial"), "Not on production")
  await user.click(screen.getByRole("button", { name: "Hide what this touches" }))
  expect(document.querySelector("dl")!.hidden).toBe(true)
  await user.click(screen.getByRole("button", { name: "What does this touch?" }))
  expect(document.querySelector("dl")!.hidden).toBe(false)
  expect((screen.getByLabelText("Note on this denial") as HTMLInputElement).value).toBe("Not on production")
})

// Reading the facts decides nothing, so a watching client, whose decisions
// are locked (Q372 A), can still open and fold them.
it("lets a watching client open and fold the facts while the decisions stay locked", async () => {
  const user = userEvent.setup()
  const approval = structuredClone(demoWorkspace).approvals[0]!
  const onResolve = vi.fn()
  render(<ApprovalCard approval={approval} onResolve={onResolve} surface="desktop" watching connected />)
  expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(true)
  const hide = screen.getByRole("button", { name: "Hide what this touches" }) as HTMLButtonElement
  expect(hide.disabled).toBe(false)
  await user.click(hide)
  expect(screen.getByRole("button", { name: "What does this touch?" })).toBeTruthy()
  expect(onResolve).not.toHaveBeenCalled()
})

// The signed web design draws no facts and no disclosure. The web card keeps
// every fact open, since a client does not omit approval facts.
it("keeps every fact open on the web card, with no disclosure", () => {
  const approval = renderThread("web")
  const card = screen.getByRole("alert")
  expect(within(card).queryByRole("button", { name: /what this touches|What does this touch/u })).toBeNull()
  expect(within(card).getByText(approval.affects)).toBeTruthy()
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

