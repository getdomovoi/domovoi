import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type ApprovalRequest } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { DenyExplainScreen } from "./deny-explain"

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

async function draw(overrides: Partial<Parameters<typeof DenyExplainScreen>[0]> = {}) {
  const props = {
    approval: approval(),
    pending: false,
    onSend: jest.fn<(explanation: string) => void>(),
    onBack: jest.fn<() => void>(),
    ...overrides,
  }
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <DenyExplainScreen {...props} />
    </SafeAreaProvider>,
  )
  return props
}

function field() {
  return screen.getByLabelText("Reason sent to the agent")
}

describe("DenyExplainScreen", () => {
  it("names the command that is not going to run", async () => {
    const { approval: request } = await draw()
    expect(screen.getByText(request.command)).toBeOnTheScreen()
  })

  // The daemon refuses an empty explanation, so the screen has to refuse it
  // first rather than spending a round trip to be told.
  it("will not send a denial with no reason in it", async () => {
    const { onSend } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Send denial" }))
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText("Write the reason the agent is given, or deny without one."))
      .toBeOnTheScreen()
  })

  it("sends the reason that was written, trimmed", async () => {
    const { onSend } = await draw()
    await fireEvent.changeText(field(), "  Run it on the WSL box instead.  ")
    await fireEvent.press(screen.getByRole("button", { name: "Send denial" }))
    expect(onSend).toHaveBeenCalledWith("Run it on the WSL box instead.")
  })

  it("writes a tapped reason into the field rather than sending it", async () => {
    const { onSend } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Wrong environment" }))
    expect(field().props.value).toBe("Wrong environment")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("keeps what was typed when a reason is tapped", async () => {
    await draw()
    await fireEvent.changeText(field(), "Only in the Thursday window")
    await fireEvent.press(screen.getByRole("button", { name: "Run it on staging" }))
    expect(field().props.value).toBe("Only in the Thursday window. Run it on staging")
  })

  it("takes a reason back out when it is tapped again", async () => {
    await draw()
    const chip = screen.getByRole("button", { name: "Needs a second reviewer" })
    await fireEvent.press(chip)
    await fireEvent.press(chip)
    expect(field().props.value).toBe("")
  })

  it("clears the refusal once a reason is written", async () => {
    await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Send denial" }))
    await fireEvent.changeText(field(), "Wrong box")
    expect(screen.queryByText("Write the reason the agent is given, or deny without one."))
      .toBeNull()
  })

  it("goes back to the decision without denying anything", async () => {
    const { onBack, onSend } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Back to the decision" }))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("sends nothing while a decision is already in flight", async () => {
    const { onSend } = await draw({ pending: true })
    await fireEvent.changeText(field(), "Wrong box")
    await fireEvent.press(screen.getByRole("button", { name: "Send denial" }))
    expect(onSend).not.toHaveBeenCalled()
  })
})
