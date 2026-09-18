import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { ScrollView } from "react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { planForSession, planSummary } from "../plan-rows"
import { sessionDetail, type SessionDetail } from "../session-detail"
import { SessionScreen } from "./session"

const metrics: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }

function fixture(): { snapshot: WorkspaceSnapshot; detail: SessionDetail } {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  const detail = sessionDetail(snapshot, "session-billing")
  if (!detail) throw new Error("fixture needs the billing session")
  return { snapshot, detail }
}

function props(detail: SessionDetail, snapshot: WorkspaceSnapshot) {
  const plan = planForSession(snapshot, "session-billing")
  if (!plan) throw new Error("fixture needs the billing plan")
  return {
    detail,
    artifacts: [],
    plan: planSummary(plan),
    pausing: false,
    draft: "",
    sending: false,
    sendProblem: "",
    skillLabel: "",
    onBack: jest.fn<() => void>(),
    onOpenApproval: jest.fn<(approvalId: string) => void>(),
    onOpenArtifact: jest.fn<(artifactId: string) => void>(),
    onPause: jest.fn<() => void>(),
    onChangeDraft: jest.fn<(draft: string) => void>(),
    onSend: jest.fn<() => void>(),
    onOpenSkills: jest.fn<() => void>(),
    onEditStep: jest.fn<(stepId: string, text: string) => Promise<void>>(async () => {}),
    planPinned: false,
    onPinPlan: jest.fn<(pinned: boolean) => void>(),
    machine: "mac-mini-m4",
    attachments: [],
    attachmentSummary: undefined,
    attachmentsAllowed: true,
    attachProblem: "",
    onPickLibrary: jest.fn<() => void>(),
    onTakePhoto: jest.fn<() => void>(),
    onRemoveAttachment: jest.fn<(index: number) => void>(),
    starting: false,
    startProblem: "",
    onStartLike: jest.fn<(prompt: string, mode: "ask" | "plan" | "build") => void>(),
  }
}

function grown(detail: SessionDetail, count: number): SessionDetail {
  const extra = Array.from({ length: count }, (_, index) => ({ id: `late-${index}`, voice: "agent" as const, body: `line ${index}`, meta: undefined }))
  return { ...detail, entries: [...detail.entries, ...extra] }
}

// The scroller only scrolls once it has measured content taller than its
// viewport, and the testing library drops scroll events on a disabled one.
async function measure() {
  await fireEvent(screen.getByTestId("thread"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } })
  await fireEvent(screen.getByTestId("thread"), "contentSizeChange", 390, 2000)
}

async function scrollTo(y: number) {
  await fireEvent.scroll(screen.getByTestId("thread"), {
    nativeEvent: { contentOffset: { x: 0, y }, layoutMeasurement: { width: 390, height: 700 }, contentSize: { width: 390, height: 2000 } },
  })
}

describe("SessionScreen follow", () => {
  it("offers the ride back with a count when output lands while scrolled up, and clears it on the jump", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    const { snapshot, detail } = fixture()
    const base = props(detail, snapshot)
    const view = await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...base} /></SafeAreaProvider>)
    expect(screen.queryByText(/new$/)).toBeNull()

    await measure()
    await scrollTo(100)
    view.rerender(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...base} detail={grown(detail, 2)} /></SafeAreaProvider>)
    expect(await screen.findByText("2 new")).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "Jump to the 2 new" }))
    expect(scrollToEnd).toHaveBeenCalled()
    expect(screen.queryByText("2 new")).toBeNull()
    scrollToEnd.mockRestore()
  })

  it("names a waiting decision instead of a count, and shows nothing at the bottom", async () => {
    const { snapshot, detail } = fixture()
    const base = props(detail, snapshot)
    const gated = { ...grown(detail, 1), approvalId: "approval-1" }
    const view = await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...base} /></SafeAreaProvider>)
    await measure()
    await scrollTo(100)
    view.rerender(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...base} detail={gated} /></SafeAreaProvider>)
    expect(await screen.findByText("Waiting on you")).toBeOnTheScreen()

    await scrollTo(1300)
    expect(screen.queryByText("Waiting on you")).toBeNull()
  })
})
