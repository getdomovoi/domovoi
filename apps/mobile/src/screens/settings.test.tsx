import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { SettingsScreen } from "./settings"

const token = "dmv_pair_4f9c2e7a1b"
const url = "ws://workshop.tailnet:47831/rpc"

async function draw(overrides: Partial<Parameters<typeof SettingsScreen>[0]> = {}) {
  const props = {
    url,
    token,
    status: "closed" as const,
    fault: undefined,
    onChangeUrl: jest.fn<(value: string) => void>(),
    onChangeToken: jest.fn<(value: string) => void>(),
    onConnect: jest.fn<() => void>(),
    onForget: jest.fn<() => void>(),
    paired: true,
    bottomInset: 0,
    ...overrides,
  }
  await render(<SettingsScreen {...props} />)
  return props
}

describe("SettingsScreen", () => {
  it("never shows the pairing token in the clear", async () => {
    await draw()

    // The token can do anything the person can do on that machine, so the
    // field that holds it is masked and no text on the screen repeats it.
    const field = screen.getByDisplayValue(token)
    expect(field.props.secureTextEntry).toBe(true)
    expect(screen.queryByText(token)).toBeNull()
    expect(screen.queryByText(new RegExp(token))).toBeNull()
  })

  it("shows the daemon address in the clear, because it is not a secret", async () => {
    await draw()

    const field = screen.getByDisplayValue(url)
    expect(field.props.secureTextEntry).toBeFalsy()
  })

  it("hands each field's typing to its own handler", async () => {
    const { onChangeUrl, onChangeToken } = await draw()

    await fireEvent.changeText(screen.getByDisplayValue(token), "dmv_pair_next")
    await fireEvent.changeText(screen.getByDisplayValue(url), "ws://other:1/rpc")

    expect(onChangeToken).toHaveBeenCalledWith("dmv_pair_next")
    expect(onChangeUrl).toHaveBeenCalledWith("ws://other:1/rpc")
    expect(onChangeToken).not.toHaveBeenCalledWith("ws://other:1/rpc")
  })

  it("connects and forgets from their own buttons", async () => {
    const { onConnect, onForget } = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Connect" }))
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(onForget).not.toHaveBeenCalled()

    await fireEvent.press(screen.getByRole("button", { name: "Forget this daemon" }))
    expect(onForget).toHaveBeenCalledTimes(1)
  })

  it("says when it has stopped trying, and why", async () => {
    await draw({
      status: "closed",
      fault: { retriable: false, headline: "The token was refused", detail: "Pair again from the desktop." },
    })

    expect(screen.getByText("Not connected, and not trying again")).toBeOnTheScreen()
    expect(screen.getByText("The token was refused")).toBeOnTheScreen()
    expect(screen.getByText("Pair again from the desktop.")).toBeOnTheScreen()
  })

  // Hiding the machine-scoped settings would leave the screen looking finished
  // when it is not. Making them tappable would offer a screen that cannot
  // exist without a machine behind it. They are listed, and they are inert.
  it("lists what a machine would unlock without letting it be pressed", async () => {
    await draw({ paired: false })

    for (const label of ["Agents and models", "Permission allow list", "Skills", "Machine defaults"]) {
      expect(screen.getByText(label)).toBeOnTheScreen()
    }
    const pressable = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)
    expect(pressable).not.toContain("Agents and models, unavailable")
    expect(screen.getByLabelText("Skills, unavailable")).toBeOnTheScreen()
  })

  it("drops the unavailable list once a machine is paired", async () => {
    await draw({ paired: true })
    expect(screen.queryByText("Machine defaults")).toBeNull()
    expect(screen.queryByText("Needs a paired machine")).toBeNull()
  })

  // Device settings are not machine settings. An unpaired phone still holds its
  // own credential, so the one control that changes that has to keep working.
  it("keeps the phone's own settings working while nothing is paired", async () => {
    const { onConnect } = await draw({ paired: false })
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }))
    expect(onConnect).toHaveBeenCalledTimes(1)
  })
})
