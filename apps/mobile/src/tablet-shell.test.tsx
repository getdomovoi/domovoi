import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { TabletShell } from "./tablet-shell"

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 1024, height: 768 },
  insets: { top: 24, left: 0, right: 0, bottom: 20 },
}

async function draw(
  risk?: "normal" | "hard-gate",
  access: "full" | "watching" = "full",
  adjust?: (snapshot: WorkspaceSnapshot) => void,
  extra: { notice?: { tone: "warning" | "destructive", headline: string, detail: string }, onPostReview?: (artifactId: string, body: string) => Promise<void> } = {},
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
    onResolve: jest.fn<(approvalId: string, decision: "allow-once" | "always-project" | "deny") => void>(),
    onDenyExplain: jest.fn<(approvalId: string) => void>(),
    onPostReview: extra.onPostReview ?? jest.fn<(artifactId: string, body: string) => Promise<void>>(async () => {}),
    ...(extra.notice ? { notice: extra.notice } : {}),
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
    expect(props.onResolve).toHaveBeenCalledWith(approval.id, "allow-once")
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

  it("offers no standing rule on a hard gate", async () => {
    await draw("hard-gate")
    expect(screen.queryByRole("button", { name: "Always here" })).toBeNull()
  })

  it("offers a standing rule when the approval is not a hard gate", async () => {
    const { props, approval } = await draw("normal")
    expect(screen.getByText("Approval required")).toBeOnTheScreen()
    expect(screen.queryByText("Approval required, hard gate")).toBeNull()
    const always = screen.getByRole("button", { name: "Always here" })
    expect(always.props.className).toContain("h-12")
    await fireEvent.press(always)
    expect(props.onResolve).toHaveBeenCalledWith(approval.id, "always-project")
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

  it("opens the four-tab review sheet and posts an anchored review draft", async () => {
    const { props } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: /Open review sheet/ }))

    expect(screen.getByRole("button", { name: "Changes" })).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Diff" })).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Plan" })).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Review" }))
    const field = screen.getByPlaceholderText("Say what is wrong with this element")
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

    expect(screen.queryByPlaceholderText("Say what is wrong with this element")).toBeNull()
    expect(screen.queryByRole("button", { name: "Post" })).toBeNull()
    expect(screen.getByText("Watching only. A device paired with full access can post a review.")).toBeOnTheScreen()
  })

  it("keeps a review draft and says why when posting it fails", async () => {
    const onPostReview = jest.fn<(artifactId: string, body: string) => Promise<void>>(async () => { throw new Error("The daemon connection is not open") })
    await draw("normal", "full", undefined, { onPostReview })
    await fireEvent.press(screen.getByRole("button", { name: /Open review sheet/ }))
    await fireEvent.press(screen.getByRole("button", { name: "Review" }))
    await fireEvent.changeText(screen.getByPlaceholderText("Say what is wrong with this element"), "The retry window is too long")
    await fireEvent.press(screen.getByRole("button", { name: "Post" }))

    expect(await screen.findByText("Not posted: The daemon connection is not open")).toBeOnTheScreen()
    expect(screen.getByDisplayValue("The retry window is too long")).toBeOnTheScreen()
  })
})

