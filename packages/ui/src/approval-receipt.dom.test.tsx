import { demoWorkspace, type FleetEntry, type FleetMachine, type ThreadItem } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
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

// Ruled Q339 A: the card calls it a note, and so does its receipt.
it("calls a denial's words a note, as the card does", () => {
  render(<ApprovalReceipt receipt={receipt({ decision: "deny-explain", explanation: "Not on production" })} />)
  expect(screen.getByText("Denied with a note")).toBeTruthy()
  expect(screen.getByText("Nothing ran. The note is recorded here; the agent was told only that you denied it.")).toBeTruthy()
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

// J34, ruled 2026-09-23: only a person's allow takes a checkpoint. A command
// a saved rule lets through later is not one, so the rule receipt says so
// where the design said it was not decided.
it("says later runs under a saved rule take no checkpoint", () => {
  render(<ApprovalReceipt receipt={receipt({ decision: "always-project" })} />)
  expect(screen.getByText(/Later runs under the rule do not take a checkpoint\./u)).toBeTruthy()
  expect(screen.queryByText(/not decided/u)).toBeNull()
})

// The design tones an allow ok and a denial danger, each with its dot.
it.each([
  ["allow-once", "ok"],
  ["always-project", "ok"],
  ["deny", "danger"],
  ["deny-explain", "danger"],
] as const)("tones a %s receipt %s", (decision, tone) => {
  render(<ApprovalReceipt receipt={receipt({ decision })} />)
  const region = screen.getByRole("region", { name: "Decision receipt" })
  expect(region.className).toContain(`bg-${tone}-background`)
  expect(region.className).toContain(`border-${tone}-border`)
  expect(region.className).not.toMatch(/\binfo-/u)
  expect(region.querySelector(`[data-receipt-dot="${tone}"]`)).not.toBeNull()
})

// The design's body reads as one paragraph: what happened to the files, then
// whether the decision outlives the moment.
it("reads the checkpoint and the rule as one body, the checkpoint first", () => {
  render(<ApprovalReceipt receipt={receipt({ checkpoint: sha, ranForMs: 38_000 })} checkpointTaken />)
  const rule = screen.getByText(/No rule was saved/u)
  const body = rule.parentElement!
  expect(body.textContent).toBe("Checkpoint abcdef10 was taken first, then it ran in 38s. Going back to it restores files in the worktree; it cannot undo effects outside it. No rule was saved, so the next request like it asks again.")
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

// Ruling Q424 A: the paired device's label travels on the receipt, so the line
// names who decided before the client kind, as the design's receipt line does.
// A receipt without one, from the daemon credential or an older snapshot,
// reads as before.
it("names the paired device that decided, from the wire, before the client", () => {
  const device = { id: `device-${"a".repeat(32)}`, label: "dana" }
  render(<ApprovalReceipt receipt={receipt({ connectionId: "conn-42", device })} />)
  expect(screen.getByText("decided from dana · desktop, connection conn-42")).toBeTruthy()
  cleanup()
  render(<ApprovalReceipt receipt={receipt({ device })} />)
  expect(screen.getByText("decided from dana · desktop")).toBeTruthy()
  cleanup()
  render(<ApprovalReceipt receipt={receipt({ clientId: "declared-1", device })} />)
  expect(screen.getByText("decided from dana · desktop, declared client declared-1")).toBeTruthy()
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

// S3.10h2: the design follows the latest receipt with what to do next. Each
// action opens a surface that already exists: the changes sheet, the machine
// menu's move, and the dock tab the decision wrote to.
function receiptThread(
  decisions: Receipt["decision"][],
  props: Partial<ComponentProps<typeof Thread>> = {},
) {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const sessionId = snapshot.activeSessionId!
  snapshot.thread = decisions.map((decision, index) => receipt({
    id: `receipt-${index}`,
    sessionId,
    decision,
    createdAt: `2026-10-02T1${index}:00:00.000Z`,
  }))
  const handlers = {
    onOpenSheet: vi.fn(),
    onOpenDockTab: vi.fn(),
    onTransferSession: vi.fn(async () => ({ state: "transferred" }) as never),
  }
  render(
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={snapshot}
      connected
      fleet={twoMachines(snapshot)}
      currentMachineId={snapshot.machine.id}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

// This machine and one more, so a move has somewhere to go.
function twoMachines(snapshot: typeof demoWorkspace): FleetEntry[] {
  const local: FleetMachine = {
    id: snapshot.machine.id,
    label: snapshot.machine.name,
    platform: snapshot.machine.platform,
    arch: snapshot.machine.arch,
    version: snapshot.machine.version,
    connection: "local",
    capabilities: ["sessions"],
    protocolVersion: "0.1.0",
    transports: [{ kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true }],
    heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
    health: "healthy",
    self: true,
  }
  const studio: FleetMachine = {
    ...local,
    id: `machine-${"b".repeat(32)}`,
    label: "studio",
    connection: "tailnet",
    transports: [{ kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true }],
    self: false,
  }
  return [local, studio].map((machine) => ({ kind: "machine" as const, machine }))
}

it("follows only the latest receipt with the design's actions", async () => {
  const user = userEvent.setup()
  const { onOpenSheet, onOpenDockTab } = receiptThread(["deny", "allow-once"])
  const actions = screen.getAllByRole("group", { name: "After this decision" })
  expect(actions).toHaveLength(1)
  const [latest] = screen.getAllByRole("region", { name: "Decision receipt" }).slice(-1)
  expect(latest!.compareDocumentPosition(actions[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  await user.click(within(actions[0]!).getByRole("button", { name: "Review the changed files" }))
  expect(onOpenSheet).toHaveBeenCalledOnce()
  await user.click(within(actions[0]!).getByRole("button", { name: "See the checkpoints" }))
  expect(onOpenDockTab).toHaveBeenCalledWith("checkpoints")
})

it("links a rule's receipt to the rule", async () => {
  const user = userEvent.setup()
  const { onOpenDockTab } = receiptThread(["always-project"])
  await user.click(screen.getByRole("button", { name: "See the rule" }))
  expect(onOpenDockTab).toHaveBeenCalledWith("rules")
  expect(screen.queryByRole("button", { name: "See the checkpoints" })).toBeNull()
})

it("opens the machine menu to move the session", async () => {
  const user = userEvent.setup()
  receiptThread(["allow-once"])
  expect(screen.queryByRole("menu")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Move this session to another machine" }))
  const menu = await screen.findByRole("menu")
  expect(within(menu).getByRole("menuitem", { name: "Move this session to studio" })).toBeTruthy()
})

// Each action shows only where its surface can open: no shell route to the
// dock tab, no move for a watching or disconnected client.
it("draws no link without a route to the dock tab", () => {
  receiptThread(["allow-once"], { onOpenDockTab: undefined })
  expect(screen.queryByRole("button", { name: /^See the/u })).toBeNull()
  expect(screen.getByRole("button", { name: "Review the changed files" })).toBeTruthy()
})

it.each([
  ["watching", { clientAccess: "watching" as const }],
  ["disconnected", { connected: false }],
  ["without a move", { onTransferSession: undefined }],
  // The menu would list no destination: the button would lead nowhere.
  ["with no other machine", { fleet: undefined }],
])("offers no move when %s", (_, props) => {
  receiptThread(["allow-once"], props)
  expect(screen.queryByRole("button", { name: "Move this session to another machine" })).toBeNull()
})

// As drawn, the follow-up row is for a connected client: offline, the changes
// sheet cannot read current Git state and nothing can move, so no action
// would do what it says.
it("draws no action row while disconnected", () => {
  receiptThread(["allow-once"], { connected: false })
  expect(screen.queryByRole("group", { name: "After this decision" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Review the changed files" })).toBeNull()
})

it("draws no action row with no action to offer", () => {
  receiptThread(["allow-once"], { onOpenSheet: undefined, onOpenDockTab: undefined, onTransferSession: undefined })
  expect(screen.queryByRole("group", { name: "After this decision" })).toBeNull()
})
