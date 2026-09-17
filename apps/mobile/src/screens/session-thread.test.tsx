import { describe, expect, it, jest } from "@jest/globals"
import { ScrollView } from "react-native"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { sessionDetail } from "../session-detail"
import { SessionScreen } from "./session"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

async function draw() {
  const detail = sessionDetail(workspace(), "session-billing")
  if (!detail) throw new Error("fixture needs the billing session")
  return render(
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
      />
    </SafeAreaProvider>,
  )
}

describe("SessionScreen thread", () => {
  // Found on a real phone during the S3.0 run: a reply that landed stayed
  // below the fold. The keyboard offset fixed in the same pass has no host
  // prop to assert against; it is checked on a device.
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
})
