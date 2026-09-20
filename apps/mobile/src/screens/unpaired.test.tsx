import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen, within } from "@testing-library/react-native"

import { UnpairedScreen } from "./unpaired"

async function draw(overrides: Partial<Parameters<typeof UnpairedScreen>[0]> = {}) {
  const props = {
    tab: "sessions" as const,
    bottomInset: 0,
    onPair: jest.fn<() => void>(),
    ...overrides,
  }
  await render(<UnpairedScreen {...props} />)
  return props
}

function buttons(): string[] {
  return screen.getAllByRole("button").map((node) => {
    if (typeof node.props.accessibilityLabel === "string") return node.props.accessibilityLabel
    return within(node).queryAllByText(/.+/).map((child) => String(child.props.children)).join(" ")
  })
}

describe("UnpairedScreen", () => {
  // The point of four screens rather than one: each tab is empty for its own
  // reason, and a shared apology would tell a person nothing about the product.
  it("gives each v2 tab its signed unpaired state", async () => {
    await draw({ tab: "sessions" })
    expect(screen.getByText("No machine is paired")).toBeOnTheScreen()
    expect(screen.getByText(/nothing to list, and nothing is being hidden from you/)).toBeOnTheScreen()

    await draw({ tab: "machines" })
    expect(screen.getByText("Machines")).toBeOnTheScreen()
    expect(screen.getByText("Pair this phone")).toBeOnTheScreen()
    expect(screen.getByText("WHAT STAYS UNAVAILABLE")).toBeOnTheScreen()
  })

  it("keeps each tab's own title above its reason", async () => {
    await draw({ tab: "machines" })
    expect(screen.getByText("Machines")).toBeOnTheScreen()
    expect(screen.getByText("Sessions")).toBeOnTheScreen()
    expect(screen.queryByText("Review")).toBeNull()
  })

  it("keeps pairing on Machines instead of duplicating it on Sessions", async () => {
    await draw({ tab: "sessions" })
    expect(screen.getByRole("button", { name: "Pair with a machine" })).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Scan a code" })).toBeNull()
  })

  it("hands pairing back to the screen that owns it", async () => {
    const { onPair } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Pair with a machine" }))
    expect(onPair).toHaveBeenCalledTimes(1)
  })

  it("offers both signed pairing paths on Machines", async () => {
    await draw({ tab: "machines" })
    expect(buttons()).toEqual(["Scan a code", "Type it"])
  })
})
