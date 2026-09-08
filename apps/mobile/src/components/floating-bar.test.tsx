import { describe, expect, it, jest } from "@jest/globals"
import { Text } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { FloatingBar, floatingBarInset } from "./floating-bar"

const notched: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

const flat: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 20, left: 0, right: 0, bottom: 0 },
}

async function draw(
  overrides: Partial<Parameters<typeof FloatingBar>[0]> = {},
  metrics: Metrics = notched,
) {
  const onFootprint = jest.fn<(footprint: number) => void>()
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <FloatingBar testID="bar" onFootprint={onFootprint} {...overrides}>
        <Text>Sessions</Text>
      </FloatingBar>
    </SafeAreaProvider>,
  )
  return { onFootprint }
}

function barStyle(): Record<string, unknown> {
  const style = screen.getByTestId("bar").props.style
  const list = Array.isArray(style) ? style : [style]
  return Object.assign({}, ...list.filter(Boolean))
}

async function layOut(height: number) {
  await fireEvent(screen.getByTestId("bar"), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 362, height } },
  })
}

describe("FloatingBar", () => {
  it("floats clear of both edges rather than filling the width", async () => {
    await draw()
    const style = barStyle()
    expect(style.position).toBe("absolute")
    expect(style.left).toBe(14)
    expect(style.right).toBe(14)
  })

  it("clears the home indicator where the device reserves room for it", async () => {
    await draw()
    expect(barStyle().bottom).toBe(notched.insets.bottom)
  })

  it("keeps the handoff's own footing where a device reserves nothing", async () => {
    await draw({}, flat)
    expect(barStyle().bottom).toBe(floatingBarInset)
  })

  // The invariant the whole component exists to keep: a scroller running under
  // the bar has to be told what the bar covers, or its last row is unreadable.
  it("reports the height it draws plus the gap underneath it", async () => {
    const { onFootprint } = await draw()
    await layOut(60)
    expect(onFootprint).toHaveBeenCalledWith(60 + notched.insets.bottom)
  })

  it("reports a smaller footprint on a phone that reserves nothing", async () => {
    const { onFootprint } = await draw({}, flat)
    await layOut(60)
    expect(onFootprint).toHaveBeenCalledWith(60 + floatingBarInset)
  })

  it("draws what it was given", async () => {
    await draw()
    expect(screen.getByText("Sessions")).toBeOnTheScreen()
  })
})
