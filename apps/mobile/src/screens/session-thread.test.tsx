import { describe, expect, it, jest } from "@jest/globals"
import { Dimensions, Keyboard, ScrollView, StyleSheet, type KeyboardEvent } from "react-native"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { act, fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import * as agentMarkdown from "../lib/agent-markdown"
import { sessionDetail } from "../session-detail"
import { SessionScreen } from "./session"

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
        onRemoveAttachments={jest.fn<() => void>()}
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

// The composer floats over the thread, absolutely positioned. F13 (walk
// 2026-10-15, iPhone): with the keyboard up the thread above it shrank but
// the composer stayed at the bottom of the screen, under the keyboard. These
// read where the composer is placed as the keyboard moves.
type KeyboardHandler = (event: KeyboardEvent) => void

function keyboardEvents() {
  const handlers = new Map<string, KeyboardHandler[]>()
  const real = Keyboard.addListener.bind(Keyboard)
  const spy = jest.spyOn(Keyboard, "addListener").mockImplementation(((name: string, handler: KeyboardHandler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler])
    return real(name as "keyboardWillShow", handler)
  }) as typeof Keyboard.addListener)
  const schedule = jest.spyOn(Keyboard, "scheduleLayoutAnimation").mockImplementation(() => {})
  const emit = async (name: string, event: KeyboardEvent) => {
    await act(async () => { for (const handler of handlers.get(name) ?? []) handler(event) })
  }
  const restore = () => {
    spy.mockRestore()
    schedule.mockRestore()
  }
  return { emit, restore }
}

function keyboardAt(height: number): KeyboardEvent {
  const window = Dimensions.get("window").height
  return {
    duration: 250,
    easing: "keyboard",
    endCoordinates: { screenX: 0, screenY: window - height, width: 390, height },
    startCoordinates: { screenX: 0, screenY: window, width: 390, height },
    isEventFromThisApp: true,
  }
}

type Node = { parent: Node | null, type: unknown, props: { style?: unknown } }

function composerBar(): Node {
  for (let at = (screen.getByLabelText("Reply to this session") as unknown as Node).parent; at; at = at.parent) {
    const style = StyleSheet.flatten(at.props.style as never) as { position?: string } | undefined
    if (typeof at.type === "string" && style?.position === "absolute") return at
  }
  throw new Error("the composer is not drawn as a floating bar")
}

function composerBottom(): unknown {
  return (StyleSheet.flatten(composerBar().props.style as never) as { bottom?: unknown }).bottom
}

// A composer that can take a message, so it can be focused.
async function drawWritable() {
  const detail = sessionDetail(workspace(), "session-billing")
  if (!detail) throw new Error("fixture needs the billing session")
  return render(screenFor({ ...detail, sending: { can: true, hint: undefined } }))
}

async function focusComposer() {
  await fireEvent(screen.getByLabelText("Reply to this session"), "focus")
}

describe("SessionScreen thread", () => {
  it("lifts the composer above the iOS keyboard and sets it back down when the keyboard goes", async () => {
    const keyboard = keyboardEvents()
    try {
      await drawWritable()
      const resting = composerBottom()
      expect(resting).toBe(metrics.insets.bottom)

      await focusComposer()
      await keyboard.emit("keyboardWillShow", keyboardAt(336))
      // The keyboard's own height plus the gap frame 12 leaves above it; the
      // home-indicator inset sits under the keyboard and is not added.
      expect(composerBottom()).toBe(336 + 8)

      await keyboard.emit("keyboardWillChangeFrame", keyboardAt(380))
      expect(composerBottom()).toBe(380 + 8)

      await keyboard.emit("keyboardWillHide", keyboardAt(0))
      expect(composerBottom()).toBe(resting)
    } finally {
      keyboard.restore()
    }
  })

  // The thread pads by what the composer covers, footprint included, so a
  // person at the bottom keeps the latest content in view as the bar rises.
  it("follows the end of the thread when the keyboard lifts the composer", async () => {
    const keyboard = keyboardEvents()
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    try {
      await drawWritable()
      const thread = screen.getByTestId("thread")
      await fireEvent(thread, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } })
      await fireEvent(thread, "contentSizeChange", 390, 900)
      await fireEvent(composerBar() as never, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 362, height: 64 } } })
      const padding = () => (StyleSheet.flatten(screen.getByTestId("thread").props.contentContainerStyle as never) as { paddingBottom?: number }).paddingBottom
      expect(padding()).toBe(64 + metrics.insets.bottom)
      scrollToEnd.mockClear()

      await focusComposer()
      await fireEvent(composerBar() as never, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 362, height: 64 } } })
      await keyboard.emit("keyboardWillShow", keyboardAt(336))
      // The thread pads by the composer's height plus where it now sits, so
      // its end stays above the lifted bar.
      expect(padding()).toBe(64 + 336 + 8)
      await fireEvent(thread, "contentSizeChange", 390, 900 + 336)
      expect(scrollToEnd).toHaveBeenCalledTimes(1)
    } finally {
      scrollToEnd.mockRestore()
      keyboard.restore()
    }
  })

  // Codex review round 2: a plan step's editor raises the keyboard too. The
  // composer is not what is being typed into, so it stays down, and the
  // screen keeps avoiding the keyboard for that editor as it did before.
  it("leaves the composer down for a keyboard another input raised, and avoids it for that input", async () => {
    const keyboard = keyboardEvents()
    try {
      await drawWritable()
      const resting = composerBottom()
      const window = Dimensions.get("window").height
      const page = screen.getByTestId("session-screen")
      await fireEvent(page, "layout", { persist: () => {}, nativeEvent: { layout: { x: 0, y: metrics.insets.top, width: 390, height: window - metrics.insets.top } } })
      const avoided = () => (StyleSheet.flatten(screen.getByTestId("session-screen").props.style as never) as { paddingBottom?: number }).paddingBottom ?? 0

      await keyboard.emit("keyboardWillShow", keyboardAt(336))
      await keyboard.emit("keyboardWillChangeFrame", keyboardAt(336))
      expect(composerBottom()).toBe(resting)
      expect(avoided()).toBeGreaterThan(0)

      // Typing into the composer hands the keyboard to the lift instead, so
      // the two never move the composer twice.
      await focusComposer()
      expect(composerBottom()).toBe(336 + 8)
      expect(avoided()).toBe(0)
    } finally {
      keyboard.restore()
    }
  })

  // Codex review round 2: with the keyboard up, the first tap on a tool
  // card's header (or any button in the thread) reaches it, rather than only
  // dismissing the keyboard.
  it("lets a tap in the thread reach its target while the keyboard is up", async () => {
    await draw()
    expect(screen.getByTestId("thread").props.keyboardShouldPersistTaps).toBe("handled")
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
