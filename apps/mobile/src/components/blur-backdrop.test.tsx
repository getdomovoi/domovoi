import { afterEach, describe, expect, it, jest } from "@jest/globals"
import type { Ref } from "react"
import { Platform, Text, View, type ViewProps } from "react-native"
import { render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { BlurBackdrop, BlurBackdropProvider } from "./blur-backdrop"
import { FloatingBar } from "./floating-bar"

// expo-blur's Android target is a native view the test renderer cannot draw.
// The stand-ins keep the two things this file is about: which props the blur
// receives, and which host view the target ref resolves to.
jest.mock("expo-blur", () => {
  const { forwardRef: forward } = jest.requireActual<typeof import("react")>("react")
  const { View: HostView } = jest.requireActual<typeof import("react-native")>("react-native")
  return {
    BlurView: (props: ViewProps) => <HostView testID="blur" {...props} />,
    BlurTargetView: forward((props: ViewProps, ref: Ref<View>) => <HostView ref={ref} {...props} />),
  }
})

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 412, height: 892 },
  insets: { top: 24, left: 0, right: 0, bottom: 0 },
}

function Probe() {
  return <View testID="content" />
}

function blurTarget(): { current: unknown } | undefined {
  return screen.getByTestId("blur").props.blurTarget as { current: unknown } | undefined
}

// The ref resolves to the renderer's host instance for the target view. It is
// read by testID and reported as a boolean: a failed toBe on a renderer
// instance prints its whole fiber graph.
function pointsAtBackdrop(): boolean {
  const current = blurTarget()?.current as { props?: { testID?: unknown } } | null | undefined
  return current?.props?.testID === "backdrop"
}

function usePlatform(os: "android" | "ios") {
  jest.replaceProperty(Platform, "OS", os)
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe("BlurBackdrop", () => {
  it("hands an Android bar the content it floats over as its blur target", async () => {
    usePlatform("android")
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <BlurBackdropProvider>
          <BlurBackdrop testID="backdrop"><Probe /></BlurBackdrop>
          <FloatingBar><Text>Sessions</Text></FloatingBar>
        </BlurBackdropProvider>
      </SafeAreaProvider>,
    )
    expect(pointsAtBackdrop()).toBe(true)
  })

  it("finds the target when the bar is drawn before the content it covers", async () => {
    usePlatform("android")
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <BlurBackdropProvider>
          <FloatingBar><Text>Sessions</Text></FloatingBar>
          <BlurBackdrop testID="backdrop"><Probe /></BlurBackdrop>
        </BlurBackdropProvider>
      </SafeAreaProvider>,
    )
    expect(pointsAtBackdrop()).toBe(true)
  })

  // A blur that samples a view it sits inside would sample itself.
  it("gives a bar drawn inside the target no target at all", async () => {
    usePlatform("android")
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <BlurBackdropProvider>
          <BlurBackdrop>
            <FloatingBar><Text>Sessions</Text></FloatingBar>
          </BlurBackdrop>
        </BlurBackdropProvider>
      </SafeAreaProvider>,
    )
    expect(blurTarget()).toBeUndefined()
  })

  it("leaves a bar with no backdrop as it was", async () => {
    usePlatform("android")
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <FloatingBar><Text>Sessions</Text></FloatingBar>
      </SafeAreaProvider>,
    )
    expect(blurTarget()).toBeUndefined()
  })

  it("passes no target on iOS, where the system blur needs none", async () => {
    usePlatform("ios")
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <BlurBackdropProvider>
          <BlurBackdrop testID="backdrop"><Probe /></BlurBackdrop>
          <FloatingBar><Text>Sessions</Text></FloatingBar>
        </BlurBackdropProvider>
      </SafeAreaProvider>,
    )
    expect(blurTarget()).toBeUndefined()
    expect(screen.getByTestId("content")).toBeOnTheScreen()
  })
})
