import { describe, expect, it, jest } from "@jest/globals"
import { ScrollView } from "react-native"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import * as agentMarkdown from "../lib/agent-markdown"
import { sessionDetail } from "../session-detail"
import { keyboardAvoidance, SessionScreen } from "./session"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

function screenFor(detail: NonNullable<ReturnType<typeof sessionDetail>>, draft = "", onWatchReceipt: () => void = jest.fn<() => void>()) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <SessionScreen
        detail={detail}
        artifacts={[]}
        plan={undefined}
        pausing={false}
        draft={draft}
        sending={false}
        sendProblem=""
        skillLabel=""
        access="full"
        onWatchReceipt={onWatchReceipt}
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
        starting={false}
        startProblem=""
        onStartLike={jest.fn<(prompt: string, mode: "ask" | "plan" | "build") => void>()}
      />
    </SafeAreaProvider>
  )
}

async function draw() {
  const detail = sessionDetail(workspace(), "session-billing")
  if (!detail) throw new Error("fixture needs the billing session")
  return render(screenFor(detail))
}

describe("SessionScreen thread", () => {
  it("offsets the iOS keyboard by the signed 390 by 844 safe-area top", () => {
    expect(keyboardAvoidance("ios", metrics.insets.top)).toEqual({
      behavior: "padding",
      keyboardVerticalOffset: metrics.insets.top,
    })
  })

  it("follows the end of the thread when a reply lands", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    await draw()
    const thread = screen.getByTestId("thread")
    await fireEvent(thread, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } } })
    await fireEvent(thread, "contentSizeChange", 390, 900)
    await fireEvent(thread, "contentSizeChange", 390, 1200)
    expect(scrollToEnd).toHaveBeenCalledTimes(2)
    scrollToEnd.mockRestore()
  })

  // Every keystroke re-renders the screen. The rows it already drew have not
  // changed, so their replies are not parsed again.
  it("does not parse the thread again when only the draft changes", async () => {
    const detail = sessionDetail(workspace(), "session-billing")
    if (!detail) throw new Error("fixture needs the billing session")
    const onWatchReceipt = jest.fn<() => void>()
    const view = await render(screenFor(detail, "", onWatchReceipt))
    const parse = jest.spyOn(agentMarkdown, "parseAgentMarkdown")
    try {
      await view.rerender(screenFor(detail, "C", onWatchReceipt))
      await view.rerender(screenFor(detail, "Co", onWatchReceipt))
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })
})

