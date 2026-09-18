import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { StopSheet } from "./stop-sheet"

async function draw() {
  const props = {
    open: true,
    onOpenStop: jest.fn<() => void>(),
    onEmergencyStop: jest.fn<() => void>(),
    onCancel: jest.fn<() => void>(),
  }
  await render(<StopSheet {...props} />)
  return props
}

describe("StopSheet", () => {
  it("keeps pausing and killing apart, and says what each one does", async () => {
    const props = await draw()

    expect(screen.getByText("Stops at the next turn boundary. Nothing is killed, and each session can be resumed.")).toBeOnTheScreen()
    expect(screen.getByText("Kills processes now, including terminals. Half-written files stay half-written.")).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "Pause everything" }))
    expect(props.onOpenStop).toHaveBeenCalledTimes(1)
    expect(props.onEmergencyStop).not.toHaveBeenCalled()
  })

  it("asks once more before the kill, from a phone it is one mis-tap away", async () => {
    const props = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Emergency stop" }))
    expect(props.onEmergencyStop).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole("button", { name: "Kill everything now" }))
    expect(props.onEmergencyStop).toHaveBeenCalledTimes(1)
  })
})
