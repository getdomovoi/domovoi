import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { Text } from "react-native"

import { AppErrorBoundary } from "./app-error-boundary"

let failing = true

function Fragile() {
  if (failing) throw new Error("A plan step had no text")
  return <Text>The sessions list</Text>
}

beforeEach(() => {
  failing = true
  jest.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("AppErrorBoundary", () => {
  it("keeps the app open on a render failure and says what failed", async () => {
    await render(<AppErrorBoundary><Fragile /></AppErrorBoundary>)

    expect(screen.getByText("Domovoi could not draw this screen")).toBeOnTheScreen()
    expect(screen.getByText("A plan step had no text")).toBeOnTheScreen()
    expect(console.error).toHaveBeenCalledWith("Domovoi could not draw this screen", expect.any(Error), expect.anything())
  })

  it("draws the app again when asked", async () => {
    await render(<AppErrorBoundary><Fragile /></AppErrorBoundary>)
    failing = false

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }))

    expect(screen.getByText("The sessions list")).toBeOnTheScreen()
  })
})
