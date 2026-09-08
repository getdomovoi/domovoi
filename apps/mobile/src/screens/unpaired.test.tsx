import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"

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

describe("UnpairedScreen", () => {
  // The point of four screens rather than one: each tab is empty for its own
  // reason, and a shared apology would tell a person nothing about the product.
  it("gives each tab its own reason for being empty", async () => {
    await draw({ tab: "sessions" })
    expect(screen.getByText("Nothing runs here yet")).toBeOnTheScreen()

    await draw({ tab: "review" })
    expect(screen.getByText("Nothing to review")).toBeOnTheScreen()

    // Fleet is the one tab whose reason for being empty is the fleet itself,
    // so its headline and its subtitle are the same sentence twice.
    await draw({ tab: "fleet" })
    expect(screen.getAllByText("No machines paired")).toHaveLength(2)
  })

  it("keeps each tab's own title above its reason", async () => {
    await draw({ tab: "review" })
    expect(screen.getByText("Review")).toBeOnTheScreen()
    expect(screen.queryByText("Sessions")).toBeNull()
    expect(screen.queryByText("Fleet")).toBeNull()
  })

  it("says the same thing about the fleet on every tab", async () => {
    for (const tab of ["sessions", "review", "fleet"] as const) {
      await draw({ tab })
      expect(screen.getAllByText("No machines paired").length).toBeGreaterThan(0)
    }
  })

  it("hands pairing back to the screen that owns it", async () => {
    const { onPair } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Pair a machine" }))
    expect(onPair).toHaveBeenCalledTimes(1)
  })

  // Pairing is the only thing that can be done from here. Anything else on
  // screen would be an action against a machine that does not exist.
  it("offers pairing and nothing else", async () => {
    await draw({ tab: "fleet" })
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })
})
