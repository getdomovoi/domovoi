import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { StyleSheet } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { sessionDetail, type SessionDetail } from "../session-detail"
import { SessionScreen } from "./session"

// Walk F21 (2026-10-15, iPhone Release build of 6f982421): a Claude Code
// thread with an allowed receipt, a denied one, a checkpoint row, tool rows
// and a reply carrying a fenced command drew as one enormous empty bordered
// frame. The frame was the agent's reply bubble with its code block inside,
// each as tall as the whole thread.
//
// React Native lays out with Yoga's legacy errata on (YGErrataAll), and under
// StretchFlexBasis a node that grows on a column axis inside a box sized to
// its content (the reply bubble is self-start) is stretched to the height its
// ancestor was offered, which in a scroller is the whole thread. A ScrollView
// grows by default (flexGrow 1), so the code block's sideways scroller did.
// The test renderer runs no layout, so this reads the styles that decide it:
// inside the thread's content nothing may grow on a column axis, because a
// scroller's content has no free height to grow into and the errata turn any
// such growth into the thread's own height.

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 440, height: 956 },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
}

const verbatim = { normalizer: (text: string) => text }

const prose = "Created the empty file. Run this to check it:"
const fenced = "ls -la walk-gate.txt"

function walkThread(): WorkspaceSnapshot {
  const workspace = structuredClone(demoWorkspace)
  workspace.approvals = []
  workspace.thread = [
    { id: "you-1", sessionId: "session-billing", kind: "user", body: "run touch walk-gate.txt", createdAt: "2026-10-15T23:50:00.000Z" },
    {
      id: "checkpoint-1",
      sessionId: "session-billing",
      kind: "checkpoint",
      reason: "before-approved-command",
      midTurn: { stability: "matched", changedPaths: [], changedPathCount: 0 },
      label: "before an approved command",
      commit: "11482bb8".padEnd(40, "0"),
      createdAt: "2026-10-15T23:51:00.000Z",
    },
    {
      id: "receipt-allow",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "allow-once",
      operation: "Create empty file walk-gate.txt",
      checkpoint: "11482bb8".padEnd(40, "0"),
      client: "phone",
      ranForMs: 7_000,
      createdAt: "2026-10-15T23:51:10.000Z",
    },
    {
      id: "tool-touch",
      sessionId: "session-billing",
      kind: "tool",
      tool: "command",
      status: "completed",
      title: "touch walk-gate.txt",
      createdAt: "2026-10-15T23:51:20.000Z",
    },
    {
      id: "assistant-1",
      sessionId: "session-billing",
      kind: "assistant",
      body: `${prose}\n\n\`\`\`bash\n${fenced}\n\`\`\``,
      createdAt: "2026-10-15T23:51:30.000Z",
    },
    {
      id: "receipt-deny",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "deny",
      operation: "Create empty file walk-deny.txt",
      checkpoint: "unavailable",
      client: "phone",
      createdAt: "2026-10-15T23:55:00.000Z",
    },
    {
      id: "tool-deny",
      sessionId: "session-billing",
      kind: "tool",
      tool: "command",
      status: "declined",
      title: "touch walk-deny.txt",
      createdAt: "2026-10-15T23:55:10.000Z",
    },
    {
      id: "assistant-2",
      sessionId: "session-billing",
      kind: "assistant",
      body: "The permission system denied `touch walk-deny.txt` as a user denial.",
      createdAt: "2026-10-15T23:55:20.000Z",
    },
  ]
  return workspace
}

function detailOf(workspace: WorkspaceSnapshot): SessionDetail {
  const detail = sessionDetail(workspace, "session-billing")
  if (!detail) throw new Error("fixture needs the billing session")
  return detail
}

function screenFor(detail: SessionDetail) {
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
        toolCardDefault="collapsed"
      />
    </SafeAreaProvider>
  )
}

type HostNode = {
  type: unknown
  props: { style?: unknown, className?: unknown, horizontal?: boolean, testID?: string, children?: unknown }
  children: Array<HostNode | string>
}

type Layout = { flexGrow?: number, flexDirection?: string }

// NativeWind turns class names into styles in the app's build, not under
// this runner, where a host node keeps its className as written. So the
// layout is read from both: the Tailwind classes that set growth and
// direction, then any style prop, which wins as it does on a device.
const classGrowth: Record<string, number> = {
  "flex-1": 1, "flex-auto": 1, "flex-initial": 0, "flex-none": 0,
  grow: 1, "grow-0": 0, "flex-grow": 1, "flex-grow-0": 0,
}

function layoutOf(node: HostNode): Layout {
  const layout: Layout = {}
  for (const name of String(node.props.className ?? "").split(/\s+/)) {
    const grow = classGrowth[name] ?? (/^grow-\[(\d+(?:\.\d+)?)\]$/.exec(name)?.[1])
    if (grow !== undefined) layout.flexGrow = Number(grow)
    if (name === "flex-row" || name === "flex-row-reverse") layout.flexDirection = "row"
    if (name === "flex-col" || name === "flex-col-reverse") layout.flexDirection = "column"
  }
  const style = (StyleSheet.flatten(node.props.style as never) ?? {}) as { flex?: number, flexGrow?: number, flexDirection?: string }
  if (style.flex !== undefined) layout.flexGrow = Math.max(0, style.flex)
  if (style.flexGrow !== undefined) layout.flexGrow = style.flexGrow
  if (style.flexDirection !== undefined) layout.flexDirection = style.flexDirection
  return layout
}

// How much a node grows on its parent's main axis. React Native gives a
// ScrollView flexGrow 1 in its own base style, which the test renderer's
// mock does not apply, so it is added back here.
function growth(node: HostNode): number {
  return layoutOf(node).flexGrow ?? (node.type === "RCTScrollView" ? 1 : 0)
}

// The axis a node lays its children on. The mock draws a ScrollView's content
// container as a plain View, which on a horizontal scroller is a row.
function axisOf(node: HostNode, parent: HostNode | undefined): "row" | "column" {
  if (parent?.type === "RCTScrollView" && parent.props.horizontal) return "row"
  const direction = layoutOf(node).flexDirection
  return direction === "row" || direction === "row-reverse" ? "row" : "column"
}

function textOf(node: HostNode): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("")
}

function describeNode(node: HostNode): string {
  const text = textOf(node).replace(/\s+/g, " ").trim().slice(0, 60)
  return `${String(node.type)}${node.props.testID ? `#${node.props.testID}` : ""} "${text}"`
}

// Every node in the thread's content that grows, by the axis it grows on.
function growthByAxis(thread: HostNode): { column: string[], row: string[] } {
  const found = { column: [] as string[], row: [] as string[] }
  const visit = (node: HostNode, parent: HostNode, grandparent: HostNode | undefined) => {
    if (growth(node) > 0) found[axisOf(parent, grandparent)].push(describeNode(node))
    for (const child of node.children) if (typeof child !== "string") visit(child, node, parent)
  }
  // The thread scroller itself fills the screen; only what it scrolls is read.
  for (const child of thread.children) if (typeof child !== "string") visit(child, thread, undefined)
  return found
}

describe("SessionScreen thread layout (walk F21)", () => {
  it("draws every item of a gated Claude Code turn", async () => {
    await render(screenFor(detailOf(walkThread())))

    expect(screen.getByText("run touch walk-gate.txt")).toBeOnTheScreen()
    expect(screen.getByText("before an approved command")).toBeOnTheScreen()
    expect(screen.getByText("Allowed once")).toBeOnTheScreen()
    expect(screen.getByText("Create empty file walk-gate.txt")).toBeOnTheScreen()
    expect(screen.getByText("Denied")).toBeOnTheScreen()
    expect(screen.getByText("Create empty file walk-deny.txt")).toBeOnTheScreen()
    expect(screen.getByTestId("tool-summary-tool-touch")).toBeOnTheScreen()
    expect(screen.getByTestId("tool-summary-tool-deny")).toBeOnTheScreen()
    expect(screen.getByText(prose)).toBeOnTheScreen()
    expect(screen.getByText(fenced, verbatim)).toBeOnTheScreen()
    expect(screen.getByText(/as a user denial/)).toBeOnTheScreen()
  })

  it("grows nothing on a column axis inside the thread, folded or open", async () => {
    await render(screenFor(detailOf(walkThread())))
    const thread = screen.getByTestId("thread") as unknown as HostNode

    const folded = growthByAxis(thread)
    expect(folded.column).toEqual([])
    // The read sees styles NativeWind wrote from class names: a folded card's
    // one-line summary takes the rest of its row with flex-1.
    expect(folded.row).toContainEqual(expect.stringContaining("touch walk-deny.txt"))

    // An open card draws its whole command under the row.
    await fireEvent.press(screen.getByRole("button", { name: /^command, completed, touch walk-gate\.txt/ }))
    expect(screen.getByText("touch walk-gate.txt", verbatim)).toBeOnTheScreen()
    expect(growthByAxis(thread).column).toEqual([])
  })
})
