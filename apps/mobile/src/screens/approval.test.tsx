import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type ApprovalRequest } from "@getdomovoi/protocol"
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
