import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type ApprovalRequest } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
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
    onDecide: jest.fn<(decision: "allow-once" | "deny") => void>(),
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

  it("sends the decision that was pressed", async () => {
    const { onDecide } = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))
    expect(onDecide).toHaveBeenLastCalledWith("deny")

    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    expect(onDecide).toHaveBeenLastCalledWith("allow-once")
    expect(onDecide).toHaveBeenCalledTimes(2)
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

  // Denying with a reason is the third answer the handoff offers, and it costs
  // a screen rather than a tap, so it must not resolve the approval from here.
  it("hands off to the explain screen without deciding anything", async () => {
    const { onDecide, onDenyExplain } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Deny and explain" }))
    expect(onDenyExplain).toHaveBeenCalledTimes(1)
    expect(onDecide).not.toHaveBeenCalled()
  })
})
