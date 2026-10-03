import { describe, expect, it, jest } from "@jest/globals"
import { Text } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { FloatingBar } from "./floating-bar"

// A stand-in that a test can find, as blur-backdrop.test.tsx draws it.
jest.mock("expo-blur", () => {
  const { View: HostView } = jest.requireActual<typeof import("react-native")>("react-native")
  return { BlurView: (props: object) => <HostView testID="blur" {...props} /> }
})

const notched: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

const flat: Metrics = {
  frame: { x: 0, y: 0, width: 412, height: 892 },
  insets: { top: 24, left: 0, right: 0, bottom: 0 },
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
  // Phone v2 draws the tab bar as a solid card and keeps the wash and blur for
  // the composer and the decision bar.
  it("draws a solid card with nothing blurred behind it when asked", async () => {
    await draw({ solid: true })
    expect(screen.queryByTestId("blur")).toBeNull()
    expect(screen.getByText("Sessions")).toBeOnTheScreen()
  })

  it("blurs what is behind it by default", async () => {
    await draw()
    expect(screen.queryByTestId("blur")).not.toBeNull()
  })

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

  it("keeps the signed Android footing on a 412 by 892 frame", async () => {
    await draw({}, flat)
    expect(barStyle().bottom).toBe(14)
  })

  // The invariant the whole component exists to keep: a scroller running under
  // the bar has to be told what the bar covers, or its last row is unreadable.
  it("reports the height it draws plus the gap underneath it", async () => {
    const { onFootprint } = await draw()
    await layOut(60)
    expect(onFootprint).toHaveBeenCalledWith(60 + notched.insets.bottom)
  })

  it("reports the signed Android footprint on a 412 by 892 frame", async () => {
    const { onFootprint } = await draw({}, flat)
    await layOut(60)
    expect(onFootprint).toHaveBeenCalledWith(60 + 14)
  })

  it("draws what it was given", async () => {
    await draw()
    expect(screen.getByText("Sessions")).toBeOnTheScreen()
  })
})
