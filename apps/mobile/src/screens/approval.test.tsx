import { describe, expect, it, jest } from "@jest/globals"
import { approvalRequestSchema, demoWorkspace, type ApprovalRequest, type WorkingPlan } from "@getdomovoi/protocol"
import { fireEvent, render, screen, within } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { ApprovalScreen } from "./approval"

function approval(): ApprovalRequest {
  const request = structuredClone(demoWorkspace).approvals[0]
  if (!request) throw new Error("fixture needs a pending approval")
  return request
}

// The bottom chrome floats above the home indicator, so it needs the metrics a
// device reports rather than a guess.
const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

async function draw(overrides: Partial<Parameters<typeof ApprovalScreen>[0]> = {}) {
  const props = {
    approval: approval(),
    pending: false,
    onDecide: jest.fn<(decision: "allow-once" | "always-project" | "deny") => void>(),
    onDenyExplain: jest.fn<() => void>(),
    onBack: jest.fn<() => void>(),
    ...overrides,
  }
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ApprovalScreen {...props} />
    </SafeAreaProvider>,
  )
  return props
}

function buttons(): string[] {
  return screen.getAllByRole("button").map((node) => {
    if (typeof node.props.accessibilityLabel === "string") return node.props.accessibilityLabel
    return within(node).queryAllByText(/.+/).map((child) => String(child.props.children)).join(" ")
  })
}

describe("ApprovalScreen", () => {
  // Phone v2 frame 02: the gate names the session it belongs to above a
  // headline that says whose turn it is, and states that the command has not
  // run, because a person deciding needs to know nothing is undone yet.
  it("heads the gate with its session and says it is waiting on you", async () => {
    await draw({ sessionTitle: "Migrate billing webhooks" })

    expect(screen.getByRole("header", { name: "Waiting on you" })).toBeOnTheScreen()
    expect(screen.getByText("Migrate billing webhooks")).toBeOnTheScreen()
    expect(screen.getByText("Nothing has run yet.")).toBeOnTheScreen()
    expect(screen.queryByText("Approval")).toBeNull()
  })

  // A watching phone cannot answer, so the gate is not waiting on it.
  it("does not tell a watching phone the gate waits on it", async () => {
    await draw({ watching: true })

    expect(screen.queryByText("Waiting on you")).toBeNull()
    expect(screen.getByRole("header", { name: "Waiting on a full-access device" })).toBeOnTheScreen()
  })

  it("shows a watching phone every fact and no decision", async () => {
    await draw({ watching: true })

    expect(screen.getByText("Apply a production database migration")).toBeOnTheScreen()
    expect(screen.getByText("pnpm prisma migrate deploy")).toBeOnTheScreen()
    expect(screen.getByText("Watching only. A device paired with full access answers this gate.")).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Always allow this" })).toBeNull()
  })

  it("shows every fact of the request without a tap", async () => {
    const { approval: request } = await draw()

    // A decision made without any of these is a decision made blind, so each
    // one has to be on screen the moment the screen opens.
    const facts = [
      request.operation,
      request.command,
      request.machine,
      request.agent,
      request.mode,
      request.directory,
      request.affects,
      request.network,
      request.estimatedDuration,
      request.checkpoint,
    ]
    for (const fact of facts) {
      expect(screen.getAllByText(fact).length).toBeGreaterThan(0)
    }
    expect(screen.getByText("Hard gate")).toBeOnTheScreen()
  })

  it("does not label a plain approval a hard gate", async () => {
    await draw({ approval: { ...approval(), risk: "normal" } })

    expect(screen.queryByText("Hard gate")).toBeNull()
  })

  it("draws one primary decision and the two signed alternatives in order", async () => {
    const { onDecide, onDenyExplain } = await draw({ approval: { ...approval(), risk: "normal" } })

    expect(buttons()).toEqual(["Back", "Allow once", "Always allow this", "Deny"])

    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))
    expect(onDenyExplain).toHaveBeenCalledTimes(1)
    expect(onDecide).not.toHaveBeenCalled()

    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    expect(onDecide).toHaveBeenLastCalledWith("allow-once")
    expect(onDecide).toHaveBeenCalledTimes(1)
  })

  it("offers to stop asking for this project, and sends the rule decision", async () => {
    const { onDecide } = await draw({ approval: { ...approval(), risk: "normal" } })

    await fireEvent.press(screen.getByRole("button", { name: "Always allow this" }))
    expect(onDecide).toHaveBeenLastCalledWith("always-project")
    expect(screen.getByText(/stops asking for this command in this project/)).toBeOnTheScreen()
  })

  // Ruled by fetzy 2026-09-24: the daemon refuses a standing rule for a request
  // it could not resolve, so the button is absent there too.
  it("does not offer a standing rule for a request the daemon could not resolve", async () => {
    await draw({ approval: { ...approval(), risk: "normal", execution: { state: "unresolved", reason: "cwd-outside-project" } } })

    expect(screen.queryByRole("button", { name: "Always allow this" })).toBeNull()
    expect(screen.queryByText(/stops asking for this command in this project/)).toBeNull()
    expect(buttons()).toEqual(["Back", "Allow once", "Deny"])
  })

  it("does not offer a standing rule on a hard gate, because the daemon refuses one", async () => {
    await draw({ approval: { ...approval(), risk: "hard-gate" } })

    expect(screen.queryByRole("button", { name: "Always allow this" })).toBeNull()
    expect(buttons()).toEqual(["Back", "Allow once", "Deny"])
  })

  it("takes no decision while one is already on its way", async () => {
    const { onDecide } = await draw({ pending: true })

    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))

    expect(onDecide).not.toHaveBeenCalled()
  })

  it("goes back when asked", async () => {
    const { onBack } = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Back" }))

    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("does not add a fourth decision beside the signed hierarchy", async () => {
    const { onDenyExplain } = await draw()
    expect(screen.queryByRole("button", { name: "Deny and explain" })).toBeNull()
    expect(onDenyExplain).not.toHaveBeenCalled()
  })

  // The route can die while a gate is open. The screen says so above the
  // decision, and a decision that could not be sent stays on screen with the
  // refusal where the buttons are, because the gate is still waiting on the
  // machine and a client that could not answer it has not changed it.
  it("says the connection is down above the decision", async () => {
    await draw({ notice: { tone: "warning", headline: "Not connected", detail: "Nothing here is live. This is the last state the phone was sent." } })

    expect(screen.getByText("Not connected")).toBeOnTheScreen()
    expect(screen.getByText("Nothing here is live. This is the last state the phone was sent.")).toBeOnTheScreen()
  })

  it("keeps the gate on screen and names why a decision was not sent", async () => {
    await draw({ problem: "Not sent: the daemon connection is not open. The gate is still waiting." })

    expect(screen.getByText("Not sent: the daemon connection is not open. The gate is still waiting.")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Allow once" })).toBeOnTheScreen()
  })
})

// The facts #740 put on the wire: which client started the turn, whether the
// request reaches outside the project and on what basis, and the plan step the
// gate blocks. Each is drawn only when the daemon sent it; an absent fact is
// one the daemon could not decide, and the phone does not decide it instead.
describe("ApprovalScreen context facts", () => {
  const connectionId = "11111111-1111-4111-8111-111111111111"
  const thisPhone = { client: "phone", deviceId: "device-0123456789abcdef0123456789abcdef" } as const

  function card(facts: Partial<Pick<ApprovalRequest, "origin" | "outsideProject">>): ApprovalRequest {
    return approvalRequestSchema.parse({ ...approval(), ...facts })
  }

  function plan(request: ApprovalRequest, approvalId = request.id): WorkingPlan {
    return {
      sessionId: request.sessionId, revision: 1, structureRevision: 1,
      createdAt: request.requestedAt, updatedAt: request.requestedAt,
      steps: [
        { id: "first", text: "Inspect", status: "completed" },
        { id: "second", text: "Change", status: "in-progress", blocker: { kind: "approval", approvalId } },
        { id: "third", text: "Verify", status: "pending" },
      ],
    }
  }

  // The fact row the label heads, read as the person reads it: label, value.
  function fact(label: string): string | undefined {
    const row = screen.queryByText(label)?.parent
    if (!row) return undefined
    return within(row).queryAllByText(/.+/).map((child) => String(child.props.children)).join(": ")
  }

  it("says the turn came from you when this phone started it", async () => {
    await draw({ approval: card({ origin: { client: "phone", connectionId, clientId: thisPhone.deviceId } }), viewer: thisPhone })

    expect(fact("Turn from")).toBe("Turn from: you, on this phone")
  })

  it.each([
    [{ client: "desktop", connectionId, clientId: "desktop-owner" }, "a desktop"],
    [{ client: "phone", connectionId, clientId: "device-ffffffffffffffffffffffffffffffff" }, "another phone"],
  ] as const)("names the other client when another one started the turn (%j)", async (origin, named) => {
    await draw({ approval: card({ origin }), viewer: thisPhone })

    expect(fact("Turn from")).toBe(`Turn from: ${named}`)
  })

  it("does not claim the turn for this phone before it knows its own id", async () => {
    await draw({ approval: card({ origin: { client: "phone", connectionId, clientId: thisPhone.deviceId } }), viewer: { client: "phone" } })

    expect(fact("Turn from")).toBe("Turn from: a phone")
    expect(screen.queryByText(/you, on this phone/)).toBeNull()
  })

  it("says the request reaches outside the project, judged by its path", async () => {
    await draw({ approval: card({ outsideProject: { outside: true, basis: "path" } }) })

    expect(fact("Outside project")).toBe("Outside project: yes, by the path it names")
    // Worn in the same warning as Affects, because it is the same kind of fact.
    expect(String(screen.getByText("yes, by the path it names").props.className)).toContain("text-warning")
  })

  it("says the request stays inside the project, judged by its path", async () => {
    await draw({ approval: card({ outsideProject: { outside: false, basis: "path" } }) })

    expect(fact("Outside project")).toBe("Outside project: no, by the path it names")
    expect(String(screen.getByText("no, by the path it names").props.className)).not.toContain("text-warning")
  })

  it("says the request runs outside the project, judged by its working directory", async () => {
    await draw({ approval: card({ outsideProject: { outside: true, basis: "working-directory" } }) })

    expect(fact("Outside project")).toBe("Outside project: yes, by where it runs")
  })

  it("judges by working directory without saying the command stays inside", async () => {
    await draw({ approval: card({ outsideProject: { outside: false, basis: "working-directory" } }) })

    expect(fact("Outside project")).toBe("Outside project: no, by where it runs, not by what it reaches")
  })

  it("draws nothing for a fact the daemon did not send", async () => {
    await draw({ approval: approval(), plans: [], viewer: thisPhone })

    expect(screen.queryByText("Turn from")).toBeNull()
    expect(screen.queryByText("Outside project")).toBeNull()
    expect(screen.queryByText("Plan")).toBeNull()
    expect(screen.queryByText(/^(yes|no),/)).toBeNull()
    expect(screen.queryByText(/step \d+ of \d+/)).toBeNull()
  })

  it("gives the plan step when the step's blocker names this approval", async () => {
    const request = approval()
    await draw({ approval: request, plans: [plan(request)] })

    expect(fact("Plan")).toBe("Plan: step 2 of 3")
  })

  it("gives no step when no step's blocker names this approval", async () => {
    const request = approval()
    await draw({ approval: request, plans: [plan(request, "approval-other")] })

    expect(screen.queryByText("Plan")).toBeNull()
    expect(screen.queryByText(/step \d+ of \d+/)).toBeNull()
  })

  // A watching phone collapses nothing it reads: the facts are the same.
  it("shows a watching phone the same facts", async () => {
    const request = card({ origin: { client: "desktop", connectionId }, outsideProject: { outside: true, basis: "path" } })
    await draw({ approval: request, plans: [plan(request)], viewer: thisPhone, watching: true })

    expect(fact("Turn from")).toBe("Turn from: a desktop")
    expect(fact("Outside project")).toBe("Outside project: yes, by the path it names")
    expect(fact("Plan")).toBe("Plan: step 2 of 3")
  })

  it("orders the new facts among the request's own", async () => {
    const request = card({ origin: { client: "desktop", connectionId }, outsideProject: { outside: true, basis: "path" } })
    await draw({ approval: request, plans: [plan(request)], viewer: thisPhone })

    const labels = ["Machine", "Agent", "Mode", "Turn from", "Plan", "Directory", "Outside project", "Affects", "Network", "Estimated", "Checkpoint"]
    const drawn = screen.getAllByText(new RegExp(`^(${labels.join("|")})$`)).map((node) => String(node.props.children))
    expect(drawn).toEqual(labels)
  })
})
