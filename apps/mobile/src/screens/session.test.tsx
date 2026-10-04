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

describe("SessionScreen messages", () => {
  // Phone v2 frame 11: an agent reply is a bordered bubble and yours is filled
  // with the primary colour. No glyph stands in for the agent, so a screen
  // reader reads the reply rather than a diamond.
  it("draws replies with no stand-in glyph for the agent", async () => {
    await draw()
    const snapshot = workspace()
    const mine = snapshot.thread.find((item) => item.sessionId === "session-billing" && item.kind === "user")
    const reply = snapshot.thread.find((item) => item.sessionId === "session-billing" && item.kind === "assistant")
    if (mine?.kind !== "user" || reply?.kind !== "assistant") throw new Error("fixture needs a message each way")

    expect(screen.queryByText("◆")).toBeNull()
    expect(screen.getByText(mine.body)).toBeOnTheScreen()
    expect(screen.getByText(reply.body)).toBeOnTheScreen()
  })
})

describe("SessionScreen decision receipt", () => {
  const allowed = {
    id: "receipt-1",
    kind: "receipt" as const,
    decision: "Allowed once",
    recorded: "allow-once" as "allow-once" | "deny",
    operation: "pnpm -w prisma migrate deploy",
    explanation: undefined,
    client: "phone",
    decidedBy: "phone",
    declaredClient: undefined as string | undefined,
    checkpoint: "8f3c1de",
    checkpointTaken: true,
    ranFor: "12s" as string | undefined,
    decidedAfter: "38s",
    current: true,
  }

  async function drawReceipt(entry: typeof allowed) {
    const { props } = await draw()
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <SessionScreen {...props} detail={{ ...props.detail, approvalId: undefined, entries: [entry] }} />
      </SafeAreaProvider>,
    )
  }

  it("turns an allowed receipt into the v2 receipt with its watch action and desktop boundary", async () => {
    await drawReceipt(allowed)

    expect(screen.getByText("Allowed once")).toBeOnTheScreen()
    expect(screen.getByText("RECORDED AS")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Watch the rest of the turn" })).toBeOnTheScreen()
    expect(screen.getByText(/Reverting happens on a desktop/)).toBeOnTheScreen()
  })

  // Phone v2 frame 03: the checkpoint is named before the duration and the
  // record lists what the audit row holds. The design's note that the row
  // names this phone's verified credential is not drawn: a receipt records a
  // client kind and a connection id, and a daemon bearer typed into Settings
  // can declare "phone" over a recorded connection too, so the phone cannot
  // show the claim is true.
  it("names the checkpoint taken first and how long the command ran", async () => {
    await drawReceipt(allowed)

    expect(screen.getByText("Checkpoint 8f3c1de was taken first, then it ran in 12s.")).toBeOnTheScreen()
    for (const [key, value] of [["Decision", "allow-once"], ["Decided on", "phone"], ["Checkpoint", "8f3c1de"]]) {
      expect(screen.getByLabelText(`${key}, ${value}`)).toBeOnTheScreen()
    }
    // Ruling Q357 A drops the gate's wait from the record on the phone.
    expect(screen.queryByLabelText(/^Decided after,/)).toBeNull()
    expect(screen.queryByText(/The audit row names this phone's verified credential/)).toBeNull()
  })

  // Ruling Q357 A: a receipt that is history, not the latest of the open
  // turn, is its headline and checkpoint line, with what it decided.
  it("draws a history receipt compact", async () => {
    await drawReceipt({ ...allowed, current: false })

    expect(screen.getByText("Allowed once")).toBeOnTheScreen()
    expect(screen.getByText("Checkpoint 8f3c1de was taken first, then it ran in 12s.")).toBeOnTheScreen()
    expect(screen.getByText("pnpm -w prisma migrate deploy")).toBeOnTheScreen()
    expect(screen.queryByText("RECORDED AS")).toBeNull()
    expect(screen.queryByRole("button", { name: "Watch the rest of the turn" })).toBeNull()
    expect(screen.queryByText(/Reverting happens on a desktop/)).toBeNull()
    expect(screen.queryByText(/The audit row names/)).toBeNull()
  })

  it("names the checkpoint alone while the command has not finished", async () => {
    await drawReceipt({ ...allowed, ranFor: undefined })

    expect(screen.getByText("Checkpoint 8f3c1de was taken first.")).toBeOnTheScreen()
  })

  // A legacy receipt carries a client id the hello declared. No credential
  // vouches for it, so it is named as declared, never as a credential, and the
  // note about a verified credential is not shown for it.
  it("names a legacy client id as declared, not as a credential", async () => {
    await drawReceipt({ ...allowed, declaredClient: "device fcbd…cdf8" })

    expect(screen.getByLabelText("Declared client, device fcbd…cdf8")).toBeOnTheScreen()
    expect(screen.queryByLabelText(/^Credential,/)).toBeNull()
    expect(screen.queryByText(/The audit row names this phone's verified credential/)).toBeNull()
  })

  it("does not speak of a phone's credential for a decision made elsewhere", async () => {
    await drawReceipt({ ...allowed, client: "desktop", decidedBy: "desktop" })

    expect(screen.getByLabelText("Decided on, desktop")).toBeOnTheScreen()
    expect(screen.queryByText(/The audit row names this phone's verified credential/)).toBeNull()
  })

  // Ruling Q424 A: the paired device the daemon wrote on the receipt names
  // who decided, label first, then the client and the shortened device id.
  it("names the deciding device in the record", async () => {
    await drawReceipt({ ...allowed, decidedBy: "dana · phone · device fcbd…cdf8" })

    expect(screen.getByLabelText("Decided on, dana · phone · device fcbd…cdf8")).toBeOnTheScreen()
  })

  it("claims no checkpoint for a receipt that took none", async () => {
    await drawReceipt({ ...allowed, decision: "Denied", recorded: "deny", checkpointTaken: false, ranFor: undefined })

    expect(screen.queryByText(/was taken first/)).toBeNull()
    expect(screen.getByText("pnpm -w prisma migrate deploy")).toBeOnTheScreen()
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
    // Frame 05 says why the buttons are absent, not only that they are.
    expect(screen.getByText("There is no approve button here, because no decision of yours can permit it. The daemon refused before the command ran.")).toBeOnTheScreen()
    expect(screen.getByText(refusal.command)).toBeOnTheScreen()
    expect(screen.getByText(refusal.rule)).toBeOnTheScreen()
    expect(screen.getByText(refusal.setBy)).toBeOnTheScreen()
    expect(screen.getByText(refusal.scope)).toBeOnTheScreen()
    expect(screen.getByText(refusal.remedy)).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
  })

  // Ruling Q356 A: the refusal's remedy can be sent to the agent as a steer
  // from the refusal itself. A watching phone cannot steer, so it gets no
  // button.
  it("tells the agent the remedy, and only from a phone that can steer", async () => {
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
    const onTellAgent = jest.fn<(text: string) => Promise<"next-turn" | "direct" | undefined>>(async () => "direct")
    const { props } = await draw({ onTellAgent })
    const canSend = { ...props.detail, policyRefusal: refusal, approvalId: undefined, sending: { can: true as const, hint: undefined } }
    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={canSend} /></SafeAreaProvider>)

    await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))
    expect(onTellAgent).toHaveBeenCalledWith(refusal.remedy)

    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} access="watching" detail={canSend} /></SafeAreaProvider>)
    expect(screen.queryByRole("button", { name: "Tell the agent" })).toBeNull()

    // A session the daemon would refuse a send to offers nothing to press.
    await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={{ ...canSend, sending: { can: false, reason: "Archived sessions are read-only." } }} /></SafeAreaProvider>)
    expect(screen.queryByRole("button", { name: "Tell the agent" })).toBeNull()
  })

  // During a running turn the remedy goes as the next turn's message, which
  // replaces one already queued (server.ts, next-turn-replace). The refusal
  // says so before the tap, and says where the message went after it, because
  // under a refusal the thread that would show it is not drawn.
  describe("telling the agent during a running turn", () => {
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
    const queuedSend = {
      id: "queue-7",
      sessionId: "session-billing",
      state: "waiting" as const,
      createdAt: "2026-09-19T23:00:00.000Z",
      origin: { client: "phone" as const, clientId: "phone-1", connectionId: "connection-1" },
      skillIds: [],
      attachments: [],
    }

    it("says the remedy replaces the message already queued", async () => {
      const { props } = await draw({ onTellAgent: jest.fn<(text: string) => Promise<"next-turn" | "direct" | undefined>>(async () => "next-turn") })
      await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={{ ...props.detail, policyRefusal: refusal, approvalId: undefined, activeTurn: true, queuedSend, sending: { can: true, hint: undefined } }} /></SafeAreaProvider>)

      expect(screen.getByText("This replaces the message already queued for the next turn.")).toBeOnTheScreen()
      // The queued message itself is shown under the refusal, with its cancel.
      expect(screen.getByText("Waiting for the next turn")).toBeOnTheScreen()
    })

    it("says where the remedy went once it is sent", async () => {
      const { props } = await draw({ onTellAgent: jest.fn<(text: string) => Promise<"next-turn" | "direct" | undefined>>(async () => "next-turn") })
      await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={{ ...props.detail, policyRefusal: refusal, approvalId: undefined, activeTurn: true, sending: { can: true, hint: undefined } }} /></SafeAreaProvider>)

      await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))

      expect(screen.getByText("Sent. It will reach the agent when this turn ends.")).toBeOnTheScreen()
    })

    // The line follows how the message was actually sent at the tap, not the
    // turn's state when the screen redraws: the turn can end, or start, in
    // between.
    it("names the delivery used at the tap, whatever the turn is doing now", async () => {
      const direct = await draw({ onTellAgent: jest.fn<(text: string) => Promise<"next-turn" | "direct" | undefined>>(async () => "direct") })
      await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...direct.props} detail={{ ...direct.props.detail, policyRefusal: refusal, approvalId: undefined, activeTurn: true, sending: { can: true, hint: undefined } }} /></SafeAreaProvider>)
      await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))
      expect(screen.getByText("Sent to the agent.")).toBeOnTheScreen()

      const queued = await draw({ onTellAgent: jest.fn<(text: string) => Promise<"next-turn" | "direct" | undefined>>(async () => "next-turn") })
      await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...queued.props} detail={{ ...queued.props.detail, policyRefusal: refusal, approvalId: undefined, activeTurn: false, sending: { can: true, hint: undefined } }} /></SafeAreaProvider>)
      await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))
      expect(screen.getByText("Sent. It will reach the agent when this turn ends.")).toBeOnTheScreen()
    })

    it("says a held remedy is held", async () => {
      const { props } = await draw({ onTellAgent: jest.fn<(text: string) => Promise<"next-turn" | "direct" | "held" | undefined>>(async () => "held") })
      await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={{ ...props.detail, policyRefusal: refusal, approvalId: undefined, activeTurn: true, sending: { can: true, hint: undefined } }} /></SafeAreaProvider>)

      await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))

      expect(screen.getByText("Held. It will not reach the agent on its own.")).toBeOnTheScreen()
      expect(screen.queryByText(/^Sent/)).toBeNull()
    })

    it("says nothing was sent when the send fails", async () => {
      const { props } = await draw({ onTellAgent: jest.fn<(text: string) => Promise<"next-turn" | "direct" | undefined>>(async () => undefined) })
      await render(<SafeAreaProvider initialMetrics={metrics}><SessionScreen {...props} detail={{ ...props.detail, policyRefusal: refusal, approvalId: undefined, activeTurn: true, sending: { can: true, hint: undefined } }} /></SafeAreaProvider>)

      await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))

      expect(screen.queryByText(/^Sent/)).toBeNull()
    })
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

  it("keeps the waiting approval in reach of a watching phone", async () => {
    const { props } = await draw({ access: "watching" })

    expect(screen.getByText("An approval is waiting on a full-access device")).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Open the waiting approval" }))
    expect(props.onOpenApproval).toHaveBeenCalledWith("approval-migrate")
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
