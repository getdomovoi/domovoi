import { describe, expect, it, jest } from "@jest/globals"
import { Platform } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { SettingsScreen } from "./settings"
import { clientVersion } from "../lib/protocol-facts"
import { deviceLabel } from "../phone-facts"

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
    onOpenStop: jest.fn<() => void>(),
    themePreference: "system" as const,
    onChangeTheme: jest.fn<(preference: "light" | "dark" | "system") => void>(),
    paired: true,
    bottomInset: 0,
    ...overrides,
  }
  await render(<SettingsScreen {...props} />)
  return props
}

describe("SettingsScreen", () => {
  it("never puts the stored credential in the rendered tree", async () => {
    await draw()

    expect(screen.queryByDisplayValue(token)).toBeNull()
    expect(screen.queryByText(token)).toBeNull()
    expect(screen.queryByText(new RegExp(token))).toBeNull()
  })

  it("keeps raw connection fields off the production settings surface", async () => {
    await draw()

    expect(screen.queryByDisplayValue(url)).toBeNull()
    expect(screen.queryByDisplayValue(token)).toBeNull()
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull()
  })

  it("opens the development diagnostic route with honest scope copy", async () => {
    const { onChangeUrl, onChangeToken, onConnect } = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Connection diagnostics" }))
    expect(screen.getByText(/credential scope is unverified/i)).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByDisplayValue(url), "ws://other:1/rpc")
    await fireEvent.changeText(screen.getByDisplayValue(token), "dmv_pair_next")
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }))

    expect(onChangeUrl).toHaveBeenCalledWith("ws://other:1/rpc")
    expect(onChangeToken).toHaveBeenCalledWith("dmv_pair_next")
    expect(onConnect).toHaveBeenCalledTimes(1)
  })

  it("forgets the saved pairing without exposing its credential", async () => {
    const { onForget } = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Forget this daemon" }))
    expect(onForget).toHaveBeenCalledTimes(1)
    expect(screen.queryByDisplayValue(token)).toBeNull()
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

  it("moves the global stop entry point into Settings", async () => {
    const { onOpenStop } = await draw()
    expect(screen.getByText(/stops at the next turn boundary/i)).toBeOnTheScreen()
    expect(screen.getByText(/kills every running agent and terminal immediately/i)).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Pause or emergency stop" }))
    expect(onOpenStop).toHaveBeenCalledTimes(1)
  })

  // The handoff's values are fixture data. A screen that repeated them would
  // tell a person the version of a build that does not exist.
  it("reports the release the greeting sends the daemon, not a written down one", async () => {
    await draw()
    expect(screen.getByLabelText(`About, ${clientVersion}`)).toBeOnTheScreen()
    expect(screen.queryByText("0.4.2")).toBeNull()
  })

  it("reports the platform it is running on, not the handoff's handset", async () => {
    await draw()
    expect(screen.getByLabelText(`This device, ${deviceLabel(Platform.OS, Platform.Version)}`))
      .toBeOnTheScreen()
    expect(screen.queryByText("iPhone 15 Pro")).toBeNull()
    // A platform that reports no version must not print the word out loud.
    expect(screen.queryByText(/undefined/)).toBeNull()
  })

  // Nothing on this screen navigates, so nothing on it is drawn as if it does.
  it("draws the phone's own facts as facts rather than as links", async () => {
    await draw()
    const pressable = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)
    expect(pressable).not.toContain(`About, ${clientVersion}`)
  })

  it("selects light, dark or system appearance", async () => {
    const { onChangeTheme } = await draw({ paired: true, themePreference: "system" })
    expect(screen.getByLabelText("Appearance, System")).toBeOnTheScreen()
    expect(screen.getByRole("radio", { name: "System", checked: true })).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("radio", { name: "Light" }))
    expect(onChangeTheme).toHaveBeenCalledWith("light")
  })
})
