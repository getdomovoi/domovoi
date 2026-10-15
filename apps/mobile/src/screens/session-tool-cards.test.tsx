import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { ScrollView } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { sessionDetail, type SessionDetail } from "../session-detail"
import type { ToolCardDefault } from "../tool-cards"
import { SessionScreen } from "./session"

// fetzy's walk (task 107): a single command card could fill several screens.
// Each tool card folds to one line and opens on a tap of its header, the
// default comes from Settings, and approval facts never fold away.

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

const longCommand = [
  "/bin/zsh -lc \"sed -n '1,135p' /Users/someone/audits/report.md\"",
  "- hostname returned workshop.local. Read running-things.md.",
  "- cat read findings/A.md, findings/B.md and findings/G.md for primary review.",
].join("\n")
// The default text matcher folds whitespace, which would let the one-line
// summary pass for the full command. The command is matched as written.
const verbatim = { normalizer: (text: string) => text }

function snapshot(options: { approval: boolean, status: "running" | "completed" }): WorkspaceSnapshot {
  const workspace = structuredClone(demoWorkspace)
  if (!options.approval) workspace.approvals = []
  workspace.thread = [
    {
      id: "tool-long",
      sessionId: "session-billing",
      kind: "tool",
      tool: "command",
      status: options.status,
      title: longCommand,
      createdAt: "2026-08-25T21:52:00.000Z",
    },
    {
      id: "tool-short",
      sessionId: "session-billing",
      kind: "tool",
      tool: "command",
      status: "completed",
      title: "pnpm test",
      createdAt: "2026-08-25T21:53:00.000Z",
    },
  ]
  return workspace
}

function detailOf(workspace: WorkspaceSnapshot): SessionDetail {
  const detail = sessionDetail(workspace, "session-billing")
  if (!detail) throw new Error("fixture needs the billing session")
  return detail
}

function screenFor(detail: SessionDetail, toolCardDefault: ToolCardDefault | undefined) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <SessionScreen
        detail={detail}
        artifacts={[]}
        plan={undefined}
        pausing={false}
        draft=""
        sending={false}
        sendProblem=""
        skillLabel=""
        access="full"
        onWatchReceipt={jest.fn<() => void>()}
        onCancelQueuedSend={jest.fn<(queueId: string) => void>()}
        onComposerFocusChange={jest.fn<(focused: boolean) => void>()}
        onBack={jest.fn<() => void>()}
        onOpenApproval={jest.fn<(approvalId: string) => void>()}
        onOpenArtifact={jest.fn<(artifactId: string) => void>()}
        onPause={jest.fn<() => void>()}
        onChangeDraft={jest.fn<(draft: string) => void>()}
        onSend={jest.fn<() => void>()}
        onOpenSkills={jest.fn<() => void>()}
        planPinned={false}
        onPinPlan={jest.fn<(pinned: boolean) => void>()}
        machine="mac-mini-m4"
        attachments={[]}
        attachmentSummary={undefined}
        attachmentsAllowed
        attachProblem=""
        onPickLibrary={jest.fn<() => void>()}
        onTakePhoto={jest.fn<() => void>()}
        onRemoveAttachment={jest.fn<(index: number) => void>()}
        onRemoveAttachments={jest.fn<() => void>()}
        starting={false}
        startProblem=""
        onStartLike={jest.fn<(prompt: string, mode: "ask" | "plan" | "build") => void>()}
        {...(toolCardDefault ? { toolCardDefault } : {})}
      />
    </SafeAreaProvider>
  )
}

function cardButton(name: RegExp) {
  return screen.getByRole("button", { name })
}

describe("SessionScreen tool cards", () => {
  it("folds a long command to one line under the collapsed default and opens it on a tap", async () => {
    await render(screenFor(detailOf(snapshot({ approval: false, status: "completed" })), "collapsed"))

    const header = cardButton(/^command, completed, \/bin\/zsh/)
    expect(header.props.accessibilityState).toMatchObject({ expanded: false })
    // The full command is not drawn while folded, only its one-line summary.
    expect(screen.queryByText(longCommand, verbatim)).toBeNull()
    const summary = screen.getByTestId("tool-summary-tool-long")
    expect(summary.props.numberOfLines).toBe(1)
    expect(summary.props.children).not.toContain("\n")

    await fireEvent.press(header)

    expect(cardButton(/^command, completed, \/bin\/zsh/).props.accessibilityState).toMatchObject({ expanded: true })
    expect(screen.getByText(longCommand, verbatim)).toBeOnTheScreen()
  })

  it("starts collapsed when no default is passed, the fresh-install choice", async () => {
    await render(screenFor(detailOf(snapshot({ approval: false, status: "completed" })), undefined))

    expect(cardButton(/^command, completed, pnpm test/).props.accessibilityState).toMatchObject({ expanded: false })
  })

  it("opens every card under the expanded default", async () => {
    await render(screenFor(detailOf(snapshot({ approval: false, status: "completed" })), "expanded"))

    expect(cardButton(/^command, completed, \/bin\/zsh/).props.accessibilityState).toMatchObject({ expanded: true })
    expect(screen.getByText(longCommand, verbatim)).toBeOnTheScreen()
  })

  it("applies a changed default to untouched cards and keeps a card the person toggled", async () => {
    const detail = detailOf(snapshot({ approval: false, status: "completed" }))
    const view = await render(screenFor(detail, "collapsed"))

    // Opened by hand under the collapsed default.
    await fireEvent.press(cardButton(/^command, completed, pnpm test/))
    expect(cardButton(/^command, completed, pnpm test/).props.accessibilityState).toMatchObject({ expanded: true })

    await view.rerender(screenFor(detail, "expanded"))
    expect(cardButton(/^command, completed, \/bin\/zsh/).props.accessibilityState).toMatchObject({ expanded: true })

    // Closed by hand under the expanded default, then the default flips back.
    await fireEvent.press(cardButton(/^command, completed, pnpm test/))
    await view.rerender(screenFor(detail, "collapsed"))
    expect(cardButton(/^command, completed, \/bin\/zsh/).props.accessibilityState).toMatchObject({ expanded: false })
    expect(cardButton(/^command, completed, pnpm test/).props.accessibilityState).toMatchObject({ expanded: false })

    // And the hand-opened choice holds against a flip the other way.
    await fireEvent.press(cardButton(/^command, completed, pnpm test/))
    await view.rerender(screenFor(detail, "collapsed"))
    expect(cardButton(/^command, completed, pnpm test/).props.accessibilityState).toMatchObject({ expanded: true })
  })

  it("never folds a running command while an approval waits on it", async () => {
    await render(screenFor(detailOf(snapshot({ approval: true, status: "running" })), "collapsed"))

    // The full command is drawn and offers no way to fold it.
    expect(screen.getByText(longCommand, verbatim)).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: /^command, running/ })).toBeNull()
    // The waiting approval's own card is still the first thing on the thread.
    expect(screen.getByLabelText("Open the waiting approval")).toBeOnTheScreen()
    // A finished command beside it still folds.
    expect(cardButton(/^command, completed, pnpm test/).props.accessibilityState).toMatchObject({ expanded: false })
  })

  // Codex review round 1: at the thread's bottom the scroller follows growth
  // to the end, so opening the last card scrolled its header and the start of
  // the command away. Opening a card holds the view for that growth; what
  // lands after it is followed as before.
  it("keeps an opened card's start in view rather than following its growth", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    try {
      await render(screenFor(detailOf(snapshot({ approval: false, status: "completed" })), "collapsed"))
      const thread = screen.getByTestId("thread")
      await fireEvent(thread, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } })
      await fireEvent(thread, "contentSizeChange", 390, 900)
      scrollToEnd.mockClear()

      await fireEvent.press(cardButton(/^command, completed, pnpm test/))
      await fireEvent(thread, "contentSizeChange", 390, 960)
      expect(scrollToEnd).not.toHaveBeenCalled()

      await fireEvent(thread, "contentSizeChange", 390, 1100)
      expect(scrollToEnd).toHaveBeenCalledTimes(1)
    } finally {
      scrollToEnd.mockRestore()
    }
  })

  it("draws an approval receipt in full under the collapsed default", async () => {
    const workspace = snapshot({ approval: false, status: "completed" })
    workspace.sessions = workspace.sessions.map((session) => session.id === "session-billing" ? { ...session, activeTurnId: "turn-open" } : session)
    workspace.thread.push({
      id: "receipt-open",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "allow-once",
      operation: "Apply a production database migration",
      checkpoint: "a".repeat(40),
      client: "phone",
      createdAt: "2026-08-25T21:54:00.000Z",
    })
    await render(screenFor(detailOf(workspace), "collapsed"))

    expect(screen.getByText("Allowed once")).toBeOnTheScreen()
    expect(screen.getByText("Apply a production database migration")).toBeOnTheScreen()
    expect(screen.getByText("RECORDED AS")).toBeOnTheScreen()
    expect(screen.getByLabelText("Decision, allow once")).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: /Apply a production database migration/ })).toBeNull()
  })
})
