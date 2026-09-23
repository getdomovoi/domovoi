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
    access: "full" as const,
    onBack: jest.fn<() => void>(),
    onWatchReceipt: jest.fn<() => void>(),
    onCancelQueuedSend: jest.fn<(queueId: string) => void>(),
    onComposerFocusChange: jest.fn<(focused: boolean) => void>(),
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
    expect(screen.getByRole("button", { name: "Looks right" })).toBeOnTheScreen()
    // The conversation is still there under the sheet.
    expect(screen.getByLabelText("Reply to this session")).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "Unpin" }))
    expect(props.onPinPlan).toHaveBeenCalledWith(false)
  })

  it("accepts the pinned plan without unpinning it", async () => {
    const { props } = await draw({ planPinned: true })
    await fireEvent.press(screen.getByRole("button", { name: /^Step 3 of 4 · / }))
    await fireEvent.press(screen.getByRole("button", { name: "Looks right" }))

    expect(screen.queryByText("The plan")).toBeNull()
    expect(props.onPinPlan).not.toHaveBeenCalled()
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

describe("SessionScreen decision receipt", () => {
  it("turns an allowed receipt into the v2 receipt with its watch action and desktop boundary", async () => {
    const { props } = await draw()
    const detail = {
      ...props.detail,
      approvalId: undefined,
      entries: [{
        id: "receipt-1",
        kind: "receipt" as const,
        decision: "Allowed once",
        operation: "pnpm -w prisma migrate deploy",
        explanation: undefined,
        attribution: "phone · device fcbd…cdf8",
        checkpoint: "8f3c1de",
        duration: "38s",
      }],
    }

    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={detail} /></SafeAreaProvider>)

    expect(screen.getByText("Allowed once")).toBeOnTheScreen()
    expect(screen.getByText("RECORDED AS")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Watch the rest of the turn" })).toBeOnTheScreen()
    expect(screen.getByText(/Reverting happens on a desktop/)).toBeOnTheScreen()
  })
})

describe("SessionScreen policy and queue states", () => {
  it("renders a policy refusal as the full state with no approval controls", async () => {
    const { props } = await draw()
    const refusal = {
      id: "refusal-1",
      kind: "policy-refusal" as const,
      operation: "Apply a production database migration",
      command: "prisma migrate deploy --url $PROD_DATABASE_URL",
      rule: "no writes to a production database",
      setBy: "dana@acme.dev",
      scope: "every machine on this account",
      remedy: "Run it against acme_dev instead.",
    }
    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={{ ...props.detail, policyRefusal: refusal, approvalId: undefined }} /></SafeAreaProvider>)

    expect(screen.getByText("Refused by policy")).toBeOnTheScreen()
    expect(screen.getByText(refusal.command)).toBeOnTheScreen()
    expect(screen.getByText(refusal.rule)).toBeOnTheScreen()
    expect(screen.getByText(refusal.setBy)).toBeOnTheScreen()
    expect(screen.getByText(refusal.scope)).toBeOnTheScreen()
    expect(screen.getByText(refusal.remedy)).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
  })

  it("shows canonical queued state and cancels by the daemon queue id", async () => {
    const { props } = await draw()
    const queuedSend = {
      id: "queue-7",
      sessionId: props.detail.id,
      state: "held" as const,
      createdAt: "2026-09-19T23:00:00.000Z",
      origin: { client: "phone" as const, clientId: "phone-1", connectionId: "connection-1" },
      skillIds: [],
      attachments: [],
      reason: "Waiting for the current turn boundary.",
    }
    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={{ ...props.detail, queuedSend }} /></SafeAreaProvider>)

    expect(screen.getByText("Held for the next turn")).toBeOnTheScreen()
    expect(screen.getByText(queuedSend.reason)).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Cancel queued message" }))
    expect(props.onCancelQueuedSend).toHaveBeenCalledWith("queue-7")
  })

  it("shows authoritative watching-only access and removes mutation controls", async () => {
    const { props } = await draw()
    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} access="watching" detail={{ ...props.detail, sending: { can: false, reason: "Watching only. This phone can read the session but cannot change it." } }} /></SafeAreaProvider>)

    expect(screen.getByText("watching")).toBeOnTheScreen()
    expect(screen.getByText("Watching only. This phone can read the session but cannot change it.")).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Pause this session" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Edit a step" })).toBeNull()
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
