import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen, within } from "@testing-library/react-native"
import { ScrollView } from "react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { railSelectionLeaves, TabletShell } from "./tablet-shell"
import { colors } from "./theme/tokens.generated"

// PR #871 review: the rail shows the open session, or the daemon's active
// one when none is open. Tapping the session it already shows is not
// leaving it, so what was picked for that session stays.
describe("railSelectionLeaves", () => {
  it("compares against the session the rail shows", () => {
    expect(railSelectionLeaves("session-billing", { openSessionId: undefined, activeSessionId: "session-billing" })).toBe(false)
    expect(railSelectionLeaves("session-audit", { openSessionId: undefined, activeSessionId: "session-billing" })).toBe(true)
    expect(railSelectionLeaves("session-audit", { openSessionId: "session-audit", activeSessionId: "session-billing" })).toBe(false)
    expect(railSelectionLeaves("session-billing", { openSessionId: "session-audit", activeSessionId: "session-billing" })).toBe(true)
    expect(railSelectionLeaves("session-billing", { openSessionId: undefined, activeSessionId: null })).toBe(true)
  })
})

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 1024, height: 768 },
  insets: { top: 24, left: 0, right: 0, bottom: 20 },
}

async function draw(
  risk?: "normal" | "hard-gate",
  access: "full" | "watching" = "full",
  adjust?: (snapshot: WorkspaceSnapshot) => void,
  extra: {
    notice?: { tone: "warning" | "destructive", headline: string, detail: string }
    onPostReview?: (artifactId: string, body: string) => Promise<void>
    deciding?: boolean
    decideProblem?: string
    sendProblem?: string
    live?: boolean
    lastReadAt?: number
  } = {},
) {
  const snapshot = structuredClone(demoWorkspace)
  const approval = snapshot.approvals[0]
  if (!approval) throw new Error("fixture needs an approval")
  if (risk) approval.risk = risk
  snapshot.activeSessionId = approval.sessionId
  const session = snapshot.sessions.find((candidate) => candidate.id === approval.sessionId)
  if (!session) throw new Error("fixture needs the approval session")
  session.workspacePath = "/worktrees/billing"
  session.providerThreadId = "provider-thread-tablet"
  adjust?.(snapshot)
  const props = {
    snapshot,
    selectedSessionId: approval.sessionId,
    draft: "Ready to send",
    access,
    sending: false,
    onSelectSession: jest.fn<(id: string) => void>(),
    onNewSession: jest.fn<() => void>(),
    onOpenMachines: jest.fn<() => void>(),
    onChangeDraft: jest.fn<(draft: string) => void>(),
    onSend: jest.fn<(sessionId: string) => void>(),
    onResolve: jest.fn<(approvalId: string, decision: "allow-once" | "always-project" | "deny", revision: number) => void>(),
    onDenyExplain: jest.fn<(approvalId: string) => void>(),
    onPostReview: extra.onPostReview ?? jest.fn<(artifactId: string, body: string) => Promise<void>>(async () => {}),
    ...(extra.notice ? { notice: extra.notice } : {}),
    live: extra.live ?? true,
    lastReadAt: extra.lastReadAt,
    deciding: extra.deciding ?? false,
    decideProblem: extra.decideProblem === undefined ? undefined : { approvalId: approval.id, text: extra.decideProblem },
    sendProblems: new Map(extra.sendProblem === undefined ? [] : [[approval.sessionId, extra.sendProblem]]),
  }
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <TabletShell {...props} />
    </SafeAreaProvider>,
  )
  return { props, approval }
}

describe("TabletShell", () => {
  it("uses a real two-pane session layout instead of stretching the phone screen", async () => {
    await draw()

    expect(screen.getByTestId("tablet-sessions-pane")).toBeOnTheScreen()
    expect(screen.getByTestId("tablet-thread")).toBeOnTheScreen()
    expect(screen.getByText("Domovoi")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "New session" })).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Machines" })).toBeOnTheScreen()
    expect(screen.getByText("NEEDS YOU")).toBeOnTheScreen()
  })

  // Tablet v2 heads the sessions pane with the shared Domovoi mark beside the
  // wordmark (ruling Q386: one mark component for phone and tablet). The
  // wordmark names it, so the mark is not announced.
  it("heads the sessions pane with the Domovoi mark", async () => {
    await draw()
    expect(screen.getByTestId("domovoi-mark", { includeHiddenElements: true })).toBeOnTheScreen()
    expect(screen.queryByRole("image", { name: "Domovoi" })).toBeNull()
  })

  it("shows a watching tablet the gate without decisions", async () => {
    await draw("hard-gate", "watching")

    expect(screen.getByText("Apply a production database migration")).toBeOnTheScreen()
    expect(screen.getByText("Watching only. A device paired with full access answers this gate.")).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull()
  })

  it("keeps the hard gate inline with tablet-sized decisions", async () => {
    const { props, approval } = await draw("hard-gate")

    expect(screen.getByText("Approval required, hard gate")).toBeOnTheScreen()
    const allow = screen.getByRole("button", { name: "Allow once" })
    const deny = screen.getByRole("button", { name: "Deny" })
    expect(allow.props.className).toContain("h-[52px]")
    expect(deny.props.className).toContain("h-12")

    await fireEvent.press(allow)
    expect(props.onResolve).toHaveBeenCalledWith(approval.id, "allow-once", 0)
  })

  // Round 4 on #545: the daemon rewrites a file card when the file it reaches
  // moves, and refuses an Allow that names the card as it was.
  it("shows the file a rewritten card reaches and answers with the revision it shows", async () => {
    const { props, approval } = await draw("normal", "full", (snapshot) => {
      const card = snapshot.approvals[0]!
      card.command = "Edit"
      card.affects = "The file two/file in the session worktree."
      card.revision = 1
    })

    expect(screen.getByText("The file two/file in the session worktree.")).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    await fireEvent.press(screen.getByRole("button", { name: "Always here" }))
    expect(props.onResolve.mock.calls).toEqual([
      [approval.id, "allow-once", 1],
      [approval.id, "always-project", 1],
    ])
  })

  it("shows every approval fact the phone shows, with none behind a tap", async () => {
    const { approval } = await draw("hard-gate")

    expect(screen.getAllByText(approval.operation).length).toBeGreaterThan(0)
    for (const label of ["Machine", "Agent", "Mode", "Directory", "Affects", "Network", "Estimated", "Checkpoint"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByText(approval.checkpoint).length).toBeGreaterThan(0)
    expect(screen.getAllByText(approval.mode).length).toBeGreaterThan(0)
  })

  // Q338 A: an answer the daemon refused is not silent. The gate is still
  // waiting, so the card stays and says why.
  it("shows why the daemon refused an answer on the gate card", async () => {
    await draw("normal", "full", undefined, { decideProblem: "The daemon refused: The approval store is unavailable. The gate is still waiting." })

    expect(screen.getByRole("alert")).toHaveTextContent("The daemon refused: The approval store is unavailable. The gate is still waiting.")
    expect(screen.getByRole("button", { name: "Allow once" })).toBeOnTheScreen()
  })

  // A connection that drops while an answer is out leaves the tablet
  // watching, and the answer may or may not have landed. The card still says
  // so: it is the one fact about the gate the person cannot see elsewhere.
  it("keeps an unconfirmed answer's sentence on a card that is now only watched", async () => {
    await draw("normal", "watching", undefined, { decideProblem: "The daemon went away before it confirmed." })

    expect(screen.getByRole("alert")).toHaveTextContent("The daemon went away before it confirmed.")
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
  })

  // While an answer is out, a second tap must not send a second one.
  it("takes no second answer while one is out", async () => {
    const { props } = await draw("normal", "full", undefined, { deciding: true })

    for (const name of ["Allow once", "Always here", "Deny"]) {
      const button = screen.getByRole("button", { name })
      expect(button).toBeDisabled()
      await fireEvent.press(button)
    }
    expect(props.onResolve).not.toHaveBeenCalled()
    expect(props.onDenyExplain).not.toHaveBeenCalled()
  })

  // The command block sits on the design's deeper warning ground
  // (--warn-bg-deep). A class naming no registered colour draws nothing.
  it("draws the command on a registered colour", async () => {
    const { approval } = await draw("hard-gate")
    let block = screen.getByText(approval.command).parent
    while (block && !/\bbg-/u.test(String(block.props.className ?? ""))) block = block.parent
    const grounds = String(block?.props.className ?? "").match(/\bbg-[a-z-]+/gu) ?? []
    expect(grounds).toHaveLength(1)
    for (const ground of grounds) expect(Object.keys(colors.light)).toContain(ground.slice(3))
  })

  it("offers no standing rule on a hard gate", async () => {
    await draw("hard-gate")
    expect(screen.queryByRole("button", { name: "Always here" })).toBeNull()
  })

  it("offers no standing rule for a request the daemon could not resolve", async () => {
    await draw("normal", "full", (snapshot) => {
      snapshot.approvals[0]!.execution = { state: "unresolved", reason: "cwd-outside-project" }
    })
    expect(screen.getByRole("button", { name: "Allow once" })).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Always here" })).toBeNull()
  })

  it("offers a standing rule when the approval is not a hard gate", async () => {
    const { props, approval } = await draw("normal")
    expect(screen.getByText("Approval required")).toBeOnTheScreen()
    expect(screen.queryByText("Approval required, hard gate")).toBeNull()
    const always = screen.getByRole("button", { name: "Always here" })
    expect(always.props.className).toContain("h-12")
    await fireEvent.press(always)
    expect(props.onResolve).toHaveBeenCalledWith(approval.id, "always-project", 0)
  })

  it("denies through the explanation step rather than a bare deny", async () => {
    const { props, approval } = await draw("hard-gate")
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))

    expect(props.onDenyExplain).toHaveBeenCalledWith(approval.id)
    expect(props.onResolve).not.toHaveBeenCalled()
  })

  it("uses the signed tablet composer and sends from the selected session", async () => {
    const { props, approval } = await draw()
    const field = screen.getByPlaceholderText("Reply, or steer the plan")
    await fireEvent.changeText(field, "Cover claim expiry")
    expect(props.onChangeDraft).toHaveBeenCalledWith("Cover claim expiry")

    await fireEvent.press(screen.getByRole("button", { name: "Send message" }))
    expect(props.onSend).toHaveBeenCalledWith(approval.sessionId)
  })

  // Q338 A: a send the daemon refused, or one that never left, says so
  // beside the composer rather than leaving the draft as though it went.
  it("says why a send failed beside the composer", async () => {
    await draw("normal", "full", undefined, { sendProblem: "The daemon connection is not open" })

    expect(screen.getByRole("alert")).toHaveTextContent("The daemon connection is not open")
  })

  // Q338 A: with no session the tablet, which has no tab bar, keeps its
  // sessions pane, so New session and Machines stay within reach.
  it("keeps New session and Machines when the machine has no session", async () => {
    const { props } = await draw(undefined, "full", (snapshot) => {
      snapshot.sessions = []
      snapshot.approvals = []
      snapshot.thread = []
      snapshot.artifacts = []
      snapshot.workingPlans = []
      snapshot.queuedSends = []
      snapshot.activeSessionId = null
    })

    expect(screen.getByTestId("tablet-sessions-pane")).toBeOnTheScreen()
    expect(screen.getByText("Everything is idle")).toBeOnTheScreen()
    expect(screen.getByText(/has no work in flight\. Empty here is a healthy state, not a failure\./u)).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "New session" }))
    await fireEvent.press(screen.getByRole("button", { name: "Machines" }))
    expect(props.onNewSession).toHaveBeenCalledTimes(1)
    expect(props.onOpenMachines).toHaveBeenCalledTimes(1)
  })

  // Q338 A: the thread reads newest last and the gate sits at its end, so it
  // opens at the latest turn rather than at the top.
  it("opens the thread at the latest turn", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    try {
      await draw()
      const thread = screen.getByTestId("tablet-thread")
      await fireEvent(thread, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 700, height: 600 } } })
      await fireEvent(thread, "contentSizeChange", 700, 1800)
      expect(scrollToEnd).toHaveBeenCalledTimes(1)
    } finally {
      scrollToEnd.mockRestore()
    }
  })

  // Q338 A: the design's "7 files" is the files the session changed, not the
  // artifacts it made.
  it("counts the files the session changed, not its artifacts", async () => {
    await draw("normal", "full", (snapshot) => {
      const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.activeSessionId)!
      session.changedFiles = 7
      expect(snapshot.artifacts.filter((artifact) => artifact.sessionId === session.id).length).not.toBe(7)
    })

    expect(screen.getByRole("button", { name: "Open review sheet, 7 files" })).toHaveTextContent("7 files")
    expect(screen.getByText(/· 7 files$/u)).toBeOnTheScreen()
  })

  it("names one changed file in the singular", async () => {
    await draw("normal", "full", (snapshot) => {
      snapshot.sessions.find((candidate) => candidate.id === snapshot.activeSessionId)!.changedFiles = 1
    })

    expect(screen.getByRole("button", { name: "Open review sheet, 1 file" })).toHaveTextContent("1 file")
  })

  // Walk F19's sweep: the work line's tool count agrees with its count too.
  it("names one tool call in the singular", async () => {
    await draw("normal", "full", (snapshot) => {
      const sessionId = snapshot.activeSessionId!
      snapshot.thread = snapshot.thread.filter((item) => item.kind !== "tool")
      snapshot.thread.push({
        id: "tool-one", sessionId, kind: "tool", tool: "command", status: "completed", title: "pnpm migrate", createdAt: "2026-08-25T21:52:00.000Z",
      })
      snapshot.sessions.find((candidate) => candidate.id === sessionId)!.changedFiles = 2
    })

    expect(screen.getByText("1 tool · 2 files")).toBeOnTheScreen()
  })

  // Q338 A: a comment posted from the tablet is anchored to the whole render
  // (cssSelector body), so the sheet says that rather than promising an
  // element the person never chose.
  it("says a tablet review comment is about the whole render", async () => {
    await draw()
    await fireEvent.press(screen.getByRole("button", { name: /Open review sheet/ }))
    await fireEvent.press(screen.getByRole("button", { name: "Review" }))

    expect(screen.queryByText(/Tap a bubble/u)).toBeNull()
    expect(screen.queryByText(/reference that element/u)).toBeNull()
    expect(screen.getByText("A comment from this tablet is about the whole render, not one element.")).toBeOnTheScreen()
    expect(screen.getByPlaceholderText("Say what is wrong with this render")).toBeOnTheScreen()
  })

  it("opens the four-tab review sheet and posts an anchored review draft", async () => {
    const { props } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: /Open review sheet/ }))

    expect(screen.getByRole("button", { name: "Changes" })).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Diff" })).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Plan" })).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Review" }))
    const field = screen.getByPlaceholderText("Say what is wrong with this render")
    await fireEvent.changeText(field, "The retry window is too long")
    await fireEvent.press(screen.getByRole("button", { name: "Post" }))

    expect(props.onPostReview).toHaveBeenCalledWith(expect.any(String), "The retry window is too long")
    expect(screen.getByRole("button", { name: "Cancel" })).toBeOnTheScreen()
  })

  it("says a watching tablet's waiting session waits on a full-access device, not on the person holding it", async () => {
    await draw("normal", "watching")

    expect(screen.getByText("waiting on a full-access device")).toBeOnTheScreen()
    expect(screen.queryByText("waiting on you")).toBeNull()
  })

  it("says a full-access tablet's waiting session waits on the person holding it", async () => {
    await draw("normal", "full")

    expect(screen.getByText("waiting on you")).toBeOnTheScreen()
  })

  // Walk F12, on the tablet's rail: a session listed as running from the last
  // state the tablet was sent may have stopped. While not live no rail row
  // keeps a live light, and "running" says it is the last read.
  it("drops the rail's live lights and says running is the last read while not live", async () => {
    await draw("normal", "full")
    const pane = screen.getByTestId("tablet-sessions-pane")
    expect(within(pane).getByText("running")).toBeOnTheScreen()
    expect(within(pane).getAllByTestId("rail-dot").some((dot) => String(dot.props.className).includes("bg-success"))).toBe(true)

    await draw("normal", "full", undefined, {
      live: false,
      notice: { tone: "warning", headline: "Not connected", detail: "Nothing here is live. This is the last state the phone was sent." },
    })
    const stale = screen.getByTestId("tablet-sessions-pane")
    expect(within(stale).queryByText("running")).toBeNull()
    expect(within(stale).getByText("running when last read")).toBeOnTheScreen()
    for (const dot of within(stale).getAllByTestId("rail-dot")) {
      expect(String(dot.props.className)).not.toMatch(/bg-success|bg-warning/)
    }
    // What waits on the person stays: it is an approval fact, and the banner
    // says none of this is live.
    expect(within(stale).getByText("waiting on you")).toBeOnTheScreen()

    // With the time the tablet received that state, the row says it, as the
    // phone's header does.
    const readAt = new Date()
    readAt.setHours(9, 5, 0, 0)
    await draw("normal", "full", undefined, { live: false, lastReadAt: readAt.getTime() })
    expect(within(screen.getByTestId("tablet-sessions-pane")).getByText("running when last read at 09:05")).toBeOnTheScreen()
  })

  // Walk F12 review: the idle pane's "Everything is idle" on the success
  // ground is a claim about now, so while not live it says idle when last read.
  it("says the machine was idle when last read in the idle pane while not live", async () => {
    await draw("normal", "full", (snapshot) => {
      snapshot.sessions = []
      snapshot.approvals = []
      snapshot.activeSessionId = null
    }, { live: false })

    expect(screen.queryByText("Everything is idle")).toBeNull()
    expect(screen.getByText("Idle when last read")).toBeOnTheScreen()
    expect(screen.getByText(/had no work in flight when last read\.$/)).toBeOnTheScreen()
  })

  it("keeps the rule, who set it, where it applies and the remedy on a policy refusal in the thread", async () => {
    const refusal = {
      id: "refusal-tablet",
      kind: "policy-refusal" as const,
      operation: "Drop the production orders table",
      command: "psql $PROD_DATABASE_URL -c 'drop table orders'",
      rule: "no writes to a production database",
      setBy: "dana@acme.dev",
      scope: "every machine on this account",
      remedy: "Run it against acme_dev instead.",
      createdAt: "2026-09-22T12:00:00.000Z",
    }
    await draw("normal", "full", (snapshot) => {
      const sessionId = snapshot.approvals[0]!.sessionId
      snapshot.thread.push({ ...refusal, sessionId })
    })

    expect(screen.getByText(refusal.operation)).toBeOnTheScreen()
    expect(screen.getByText(refusal.command)).toBeOnTheScreen()
    expect(screen.getByText(refusal.rule)).toBeOnTheScreen()
    expect(screen.getByText(refusal.setBy)).toBeOnTheScreen()
    expect(screen.getByText(refusal.scope)).toBeOnTheScreen()
    expect(screen.getByText(refusal.remedy)).toBeOnTheScreen()
  })

  // Ruling Q424 A: the receipt names the device that decided. A decision also
  // carries how long the gate waited, and the one must not hide the other.
  it("names the deciding device on a receipt that also carries a duration", async () => {
    await draw("normal", "full", (snapshot) => {
      snapshot.thread.push({
        id: "receipt-tablet",
        sessionId: snapshot.approvals[0]!.sessionId,
        kind: "receipt",
        decision: "allow-once",
        operation: "pnpm -w prisma migrate deploy",
        checkpoint: "8f3c1de0000000000000000000000000deadbeef",
        client: "phone",
        device: { id: "device-fcbd4c3f99c7294586f0c5ca22f9cdf8", label: "dana" },
        decisionDurationMs: 38_400,
        createdAt: "2026-08-25T21:52:00.000Z",
      })
    })

    expect(screen.getByText("dana · phone · device fcbd…cdf8 · decided after 38s")).toBeOnTheScreen()
  })

  // The tablet receipt says what the phone's says: a checkpoint only when an
  // allow took one, how long the command ran when it has, and the gate's wait
  // under its own name rather than as an unlabeled number.
  describe("receipts", () => {
    function receipt(id: string, decision: "allow-once" | "deny", checkpoint: string, extra: { ranForMs?: number, decisionDurationMs?: number } = {}) {
      return {
        id, kind: "receipt" as const, decision, operation: `operation ${id}`, checkpoint,
        client: "tablet" as const, createdAt: "2026-09-22T12:00:00.000Z", ...extra,
      }
    }
    const commit = "8f3c1de0000000000000000000000000deadbeef"

    it("names the checkpoint an allow took and how long it ran, and labels the wait", async () => {
      await draw("normal", "full", (snapshot) => {
        snapshot.thread.push({ ...receipt("allowed", "allow-once", commit, { ranForMs: 12_000, decisionDurationMs: 38_000 }), sessionId: snapshot.approvals[0]!.sessionId })
      })
      expect(screen.getByText("Checkpoint 8f3c1de was taken first, then it ran in 12s.")).toBeOnTheScreen()
      // Who decided comes first on the meta line (ruling Q424 A).
      expect(screen.getByText("tablet · decided after 38s")).toBeOnTheScreen()
    })

    it("claims no checkpoint for a deny", async () => {
      await draw("normal", "full", (snapshot) => {
        snapshot.thread.push({ ...receipt("denied", "deny", commit), sessionId: snapshot.approvals[0]!.sessionId })
      })
      expect(screen.getByText("operation denied")).toBeOnTheScreen()
      // The open gate beside it has a Checkpoint fact; the receipt's sentence
      // is what must be absent.
      expect(screen.queryByText(/was taken first|was recorded before it ran/)).toBeNull()
    })

    it("says nothing about a checkpoint an allow could not take", async () => {
      await draw("normal", "full", (snapshot) => {
        snapshot.thread.push({ ...receipt("unchecked", "allow-once", "unavailable"), sessionId: snapshot.approvals[0]!.sessionId })
      })
      expect(screen.getByText("operation unchecked")).toBeOnTheScreen()
      expect(screen.queryByText(/no checkpoint/)).toBeNull()
    })

    // P2: an allow that could take no checkpoint still ran, and how long it
    // ran is its own sentence, as on the phone.
    it("keeps the run time of an allow that took no checkpoint", async () => {
      await draw("normal", "full", (snapshot) => {
        snapshot.thread.push({ ...receipt("unchecked", "allow-once", "unavailable", { ranForMs: 38_000 }), sessionId: snapshot.approvals[0]!.sessionId })
      })
      expect(screen.getByText("It ran in 38s.")).toBeOnTheScreen()
      expect(screen.queryByText(/was taken first/u)).toBeNull()
    })
  })

  it("shows the connection notice, so a tablet hears when the daemon sent something it could not read", async () => {
    await draw("normal", "full", undefined, { notice: {
      tone: "warning",
      headline: "This app is out of date with the daemon",
      detail: "The daemon sent a workspace.changed notification this app could not read, so what is on screen may be missing a change. Update the app.",
    } })

    expect(screen.getByText("This app is out of date with the daemon")).toBeOnTheScreen()
  })

  it("offers a watching tablet no review controls and says who can post one", async () => {
    await draw("normal", "watching")
    await fireEvent.press(screen.getByRole("button", { name: /Open review sheet/ }))
    await fireEvent.press(screen.getByRole("button", { name: "Review" }))

    expect(screen.queryByPlaceholderText("Say what is wrong with this render")).toBeNull()
    expect(screen.queryByRole("button", { name: "Post" })).toBeNull()
    expect(screen.getByText("Watching only. A device paired with full access can post a review.")).toBeOnTheScreen()
  })

  it("keeps a review draft and says why when posting it fails", async () => {
    const onPostReview = jest.fn<(artifactId: string, body: string) => Promise<void>>(async () => { throw new Error("The daemon connection is not open") })
    await draw("normal", "full", undefined, { onPostReview })
    await fireEvent.press(screen.getByRole("button", { name: /Open review sheet/ }))
    await fireEvent.press(screen.getByRole("button", { name: "Review" }))
    await fireEvent.changeText(screen.getByPlaceholderText("Say what is wrong with this render"), "The retry window is too long")
    await fireEvent.press(screen.getByRole("button", { name: "Post" }))

    expect(await screen.findByText("Not posted: The daemon connection is not open")).toBeOnTheScreen()
    expect(screen.getByDisplayValue("The retry window is too long")).toBeOnTheScreen()
  })

  // Codex review of PR #717, round 2: at tablet widths App draws this shell,
  // not the phone's SessionScreen. A message that left open comments over the
  // per-turn limit says so under that message here too, whether it was sent
  // directly or released from the daemon's queue.
  describe("open comments left over the per-turn limit", () => {
    const note = "1 open annotation was over the per-turn limit"
    const overLimitBody = "Address every open comment"
    const plainBody = "Then rerun the billing tests"

    // A send that named the newest 20 of 21 open comments, as the daemon
    // records it.
    function overLimitSend(sessionId: string, id: string, turnId?: string) {
      return {
        id,
        sessionId,
        kind: "user" as const,
        ...(turnId ? { turnId } : {}),
        body: overLimitBody,
        providerPromptDelivery: {
          version: 1 as const,
          budget: { unit: "utf16-code-units" as const, limit: 262_144, used: 9_000 },
          handoff: { status: "not-required" as const },
          workingPlan: { status: "not-required" as const },
          annotations: {
            availableCount: 21,
            deliveredIds: Array.from({ length: 20 }, (_, index) => `annotation-${index + 1}`),
            omitted: { budget: 0, limit: 1 },
          },
          skills: { selection: "project-default" as const, delivered: [], omitted: { budget: [], limit: [], unavailable: [], reviewChanged: [], policy: [] } },
        },
        createdAt: "2026-10-03T09:00:00.000Z",
      }
    }

    function plainSend(sessionId: string) {
      return { id: "thread-plain", sessionId, kind: "user" as const, body: plainBody, createdAt: "2026-10-03T09:01:00.000Z" }
    }

    // The note belongs to the message it describes: the nearest element that
    // holds both is that message's own, not the thread holding every message.
    function expectNoteUnder(body: string) {
      expect(screen.getAllByText(note)).toHaveLength(1)
      let holder = screen.getByText(note).parent
      while (holder && !within(holder).queryByText(body)) holder = holder.parent
      expect(holder).not.toBeNull()
      if (!holder) return
      expect(within(holder).queryByText(plainBody)).toBeNull()
    }

    it("shows it under a message sent directly", async () => {
      await draw(undefined, "full", (snapshot) => {
        const sessionId = snapshot.activeSessionId
        if (!sessionId) throw new Error("fixture needs an active session")
        snapshot.thread.push(overLimitSend(sessionId, "thread-over-limit"), plainSend(sessionId))
        workspaceSnapshotSchema.parse(snapshot)
      })

      expect(screen.getByText(overLimitBody)).toBeOnTheScreen()
      expect(screen.getByText(note)).toBeOnTheScreen()
      expectNoteUnder(overLimitBody)
    })

    it("shows it under a queued message once the daemon delivered it", async () => {
      await draw(undefined, "full", (snapshot) => {
        const sessionId = snapshot.activeSessionId
        if (!sessionId) throw new Error("fixture needs an active session")
        snapshot.queuedSends = [{
          id: "queue-over-limit",
          sessionId,
          state: "delivered",
          createdAt: "2026-10-03T08:59:00.000Z",
          origin: { client: "phone", connectionId: "3f1c2b8e-1d2a-4c5b-9e6f-7a8b9c0d1e2f" },
          skillIds: [],
          attachments: [],
        }]
        snapshot.thread.push(overLimitSend(sessionId, "thread-queued-over-limit", "a".repeat(64)), plainSend(sessionId))
        workspaceSnapshotSchema.parse(snapshot)
      })

      expect(screen.getByText(overLimitBody)).toBeOnTheScreen()
      expect(screen.getByText(note)).toBeOnTheScreen()
      expectNoteUnder(overLimitBody)
    })
  })

  // Walk finding F26: the tablet names what a sent message carried under
  // it, as the phone does, from the record alone.
  it("names the attachments a sent message carried under that message", async () => {
    await draw(undefined, "full", (snapshot) => {
      const sessionId = snapshot.activeSessionId
      if (!sessionId) throw new Error("fixture needs an active session")
      snapshot.thread.push({
        id: "thread-photo", sessionId, kind: "user", body: "Describe this image", createdAt: "2026-10-16T12:00:00.000Z",
        attachments: [{ kind: "text", name: "terminal-output.txt", bytes: 3_200 }],
      })
      workspaceSnapshotSchema.parse(snapshot)
    })

    expect(screen.getByText("Describe this image")).toBeOnTheScreen()
    const chip = screen.getByLabelText("Text file terminal-output.txt, 3.2 kB")
    expect(within(chip).getByText("LOG", { includeHiddenElements: true })).toBeTruthy()
    expect(within(chip).getByText("terminal-output.txt", { includeHiddenElements: true })).toBeTruthy()
  })
})

