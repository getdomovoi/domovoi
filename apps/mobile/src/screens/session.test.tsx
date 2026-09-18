import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { planForSession, planSummary } from "../plan-rows"
import { sessionDetail } from "../session-detail"
import { SessionScreen } from "./session"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

async function draw(overrides: Partial<Parameters<typeof SessionScreen>[0]> = {}) {
  const snapshot = workspace()
  const detail = sessionDetail(snapshot, "session-billing")
  const plan = planForSession(snapshot, "session-billing")
  if (!detail || !plan) throw new Error("fixture needs the billing session and its plan")
  const props = {
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
    ...overrides,
  }
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <SessionScreen {...props} />
    </SafeAreaProvider>,
  )
  return { props, plan }
}

describe("SessionScreen plan", () => {
  it("says when the plan was revised and when an edit takes effect", async () => {
    await draw()

    expect(screen.getByText(/^revised \d\d:\d\d$/)).toBeOnTheScreen()
    expect(screen.getByText("Editing a step here applies at the next turn boundary, not to the turn in flight.")).toBeOnTheScreen()
  })

  it("rewrites one step and sends it with the step's id", async () => {
    const { props, plan } = await draw()
    const target = plan.steps[3]
    if (!target) throw new Error("fixture needs four steps")

    await fireEvent.press(screen.getByRole("button", { name: "Edit a step" }))
    await fireEvent.press(screen.getByRole("button", { name: `Edit step 4: ${target.text}` }))
    const field = screen.getByLabelText("Step 4")
    expect(field.props.value).toBe(target.text)
    await fireEvent.changeText(field, "Cover expiry and duplicate delivery in replay.spec.ts")
    await fireEvent.press(screen.getByRole("button", { name: "Save step" }))

    expect(props.onEditStep).toHaveBeenCalledWith(target.id, "Cover expiry and duplicate delivery in replay.spec.ts")
  })

  it("will not save a step emptied of its text", async () => {
    const { props, plan } = await draw()
    const target = plan.steps[3]
    if (!target) throw new Error("fixture needs four steps")

    await fireEvent.press(screen.getByRole("button", { name: "Edit a step" }))
    await fireEvent.press(screen.getByRole("button", { name: `Edit step 4: ${target.text}` }))
    await fireEvent.changeText(screen.getByLabelText("Step 4"), "   ")
    await fireEvent.press(screen.getByRole("button", { name: "Save step" }))

    expect(props.onEditStep).not.toHaveBeenCalled()
  })

  it("offers no editing when the screen was given no way to send one", async () => {
    await draw({ onEditStep: undefined })

    expect(screen.queryByRole("button", { name: "Edit a step" })).toBeNull()
    expect(screen.queryByText(/applies at the next turn boundary/)).toBeNull()
  })

  it("pins the plan from the card, so it follows the person across screens", async () => {
    const { props } = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Pin the plan" }))

    expect(props.onPinPlan).toHaveBeenCalledWith(true)
  })
})

describe("SessionScreen pinned plan", () => {
  it("draws a strip above the thread instead of the card, naming the step in progress", async () => {
    await draw({ planPinned: true })

    expect(screen.getByRole("button", { name: /^Step 3 of 4 · / })).toBeOnTheScreen()
    expect(screen.queryByText("Working plan")).toBeNull()
    expect(screen.queryByRole("button", { name: "Edit a step" })).toBeNull()
  })

  it("lifts the whole plan as a sheet when the strip is tapped, thread still behind it", async () => {
    const { props, plan } = await draw({ planPinned: true })

    await fireEvent.press(screen.getByRole("button", { name: /^Step 3 of 4 · / }))

    expect(screen.getByText("The plan")).toBeOnTheScreen()
    expect(screen.getByText(/^revised \d\d:\d\d$/)).toBeOnTheScreen()
    for (const step of plan.steps) expect(screen.getByText(step.text)).toBeOnTheScreen()
    expect(screen.getByText("Pinned stays pinned across screens. Unpin and it collapses back into the thread.")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Edit a step" })).toBeOnTheScreen()
    // The conversation is still there under the sheet.
    expect(screen.getByLabelText("Reply to this session")).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "Unpin" }))
    expect(props.onPinPlan).toHaveBeenCalledWith(false)
  })

  it("edits a step from the sheet with the same sender", async () => {
    const { props, plan } = await draw({ planPinned: true })
    const target = plan.steps[3]
    if (!target) throw new Error("fixture needs four steps")

    await fireEvent.press(screen.getByRole("button", { name: /^Step 3 of 4 · / }))
    await fireEvent.press(screen.getByRole("button", { name: "Edit a step" }))
    await fireEvent.press(screen.getByRole("button", { name: `Edit step 4: ${target.text}` }))
    await fireEvent.changeText(screen.getByLabelText("Step 4"), "Cover expiry in replay.spec.ts")
    await fireEvent.press(screen.getByRole("button", { name: "Save step" }))

    expect(props.onEditStep).toHaveBeenCalledWith(target.id, "Cover expiry in replay.spec.ts")
  })
})

describe("SessionScreen start another", () => {
  it("starts another session like this one from the session itself, in Plan by default", async () => {
    const { props } = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Start another like this one" }))
    expect(screen.getByText(/Same machine, repository, provider and model/)).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByLabelText("What to do"), "Cover the claim-expiry case")
    await fireEvent.press(screen.getByRole("button", { name: "Start" }))

    expect(props.onStartLike).toHaveBeenCalledWith("Cover the claim-expiry case", "plan")
  })

  it("reads a fresh session as ready to start rather than as empty", async () => {
    const { props } = await draw()
    const fresh = { ...props.detail, entries: [], omitted: 0, sending: { can: true as const, hint: undefined } }
    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={fresh} /></SafeAreaProvider>)
    expect(screen.getByText("Nothing has run yet")).toBeOnTheScreen()
    expect(screen.getByText(/Your first message is what starts it/)).toBeOnTheScreen()
    expect(screen.queryByText(/Nothing has been said/)).toBeNull()
  })
})
