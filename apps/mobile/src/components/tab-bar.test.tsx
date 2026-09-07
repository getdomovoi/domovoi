import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { TabBar, type Tab } from "./tab-bar"

// A notched iPhone reserves room under the bar for the home indicator. The bar
// floats above that room rather than filling it, and reports the whole
// footprint so the list behind it can pad by exactly that much.
const notched: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

async function draw(
  overrides: Partial<Parameters<typeof TabBar>[0]> = {},
  metrics: Metrics = notched,
) {
  const props = {
    active: "sessions" as Tab,
    waiting: 0,
    onSelect: jest.fn<(tab: Tab) => void>(),
    onFootprint: jest.fn<(footprint: number) => void>(),
    ...overrides,
  }
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <TabBar {...props} />
    </SafeAreaProvider>,
  )
  return props
}

async function layOut(height: number) {
  const bar = screen.getByTestId("tab-bar")
  await fireEvent(bar, "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 362, height } },
  })
}

describe("TabBar", () => {
  it("draws the four tabs the handoff draws, in its order", async () => {
    await draw()
    expect(screen.getAllByRole("tab").map((node) => node.props.accessibilityLabel))
      .toEqual(["Sessions", "Review", "Fleet", "Settings"])
  })

  it("marks only the tab being looked at", async () => {
    await draw({ active: "review" })
    expect(screen.getAllByRole("tab").map((node) => node.props.accessibilityState.selected))
      .toEqual([false, true, false, false])
  })

  // The count is the reason to pick the phone up, so a screen reader is told it
  // rather than being handed a tab called Sessions with a number drawn on it.
  it("says how many approvals are waiting", async () => {
    await draw({ waiting: 2 })
    expect(screen.getByRole("tab", { name: "Sessions, 2 waiting" })).toBeOnTheScreen()
    expect(screen.getByText("2")).toBeOnTheScreen()
  })

  it("says nothing about a count of none", async () => {
    await draw()
    expect(screen.getByRole("tab", { name: "Sessions" })).toBeOnTheScreen()
    expect(screen.queryByText("0")).toBeNull()
  })

  it("hands back the tab that was tapped", async () => {
    const { onSelect } = await draw()
    await fireEvent.press(screen.getByRole("tab", { name: "Fleet" }))
    expect(onSelect).toHaveBeenCalledWith("fleet")
  })

  // The bar floats over the list rather than sitting under it, so the list has
  // to know what it covers. Getting this wrong hides the last session.
  it("tells the list what it covers, home indicator included", async () => {
    const { onFootprint } = await draw()
    await layOut(54)
    expect(onFootprint).toHaveBeenCalledWith(54 + notched.insets.bottom)
  })

  it("keeps the handoff's own footing where a device reserves nothing", async () => {
    const { onFootprint } = await draw({}, {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 20, left: 0, right: 0, bottom: 0 },
    })
    await layOut(54)
    expect(onFootprint).toHaveBeenCalledWith(54 + 22)
  })
})
