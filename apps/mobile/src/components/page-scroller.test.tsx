import { describe, expect, it, jest } from "@jest/globals"
import { RefreshControl, Text } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { PageScroller } from "./page-scroller"

async function draw(overrides: Partial<Parameters<typeof PageScroller>[0]> = {}) {
  await render(
    <PageScroller testID="scroller" {...overrides}>
      <Text>A row</Text>
    </PageScroller>,
  )
}

function scroller() {
  return screen.getByTestId("scroller")
}

async function layOut(height: number) {
  await fireEvent(scroller(), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
  })
}

async function fill(height: number) {
  await fireEvent(scroller(), "contentSizeChange", 390, height)
}

function enabled(): boolean {
  return scroller().props.scrollEnabled
}

function bounces(): boolean {
  return scroller().props.alwaysBounceVertical
}

describe("PageScroller", () => {
  // A bounce says there is more below. On a screen that fits, it says the app
  // is broken.
  it("stops a screen that fits from scrolling or bouncing", async () => {
    await draw()
    await layOut(844)
    await fill(400)
    expect(enabled()).toBe(false)
    expect(bounces()).toBe(false)
  })

  it("scrolls a screen whose content is taller than it is", async () => {
    await draw()
    await layOut(844)
    await fill(1600)
    expect(enabled()).toBe(true)
    expect(bounces()).toBe(true)
  })

  // The reason the measurement lives here rather than at each call site: the
  // bar's footprint is part of the content box, so a screen that only fits
  // because the bar was ignored still has something below the fold.
  it("counts the floating bar's footprint as content", async () => {
    await draw({ bottomInset: 90 })
    expect(scroller().props.contentContainerStyle).toContainEqual({ paddingBottom: 90 })
  })

  // An empty session list that receives its first session has to start
  // scrolling where it stands.
  it("turns scrolling back on when a short screen grows", async () => {
    await draw()
    await layOut(844)
    await fill(400)
    expect(enabled()).toBe(false)

    await fill(1600)
    expect(enabled()).toBe(true)
  })

  it("turns scrolling off again when a tall screen shrinks", async () => {
    await draw()
    await layOut(844)
    await fill(1600)
    await fill(300)
    expect(enabled()).toBe(false)
  })

  // The pull is the only way to reach a refresh, so a short list keeps it.
  it("keeps a refreshing screen bouncing even when it fits", async () => {
    await draw({
      refreshControl: <RefreshControl refreshing={false} onRefresh={jest.fn<() => void>()} />,
    })
    await layOut(844)
    await fill(400)
    expect(enabled()).toBe(true)
    expect(bounces()).toBe(true)
  })

  it("keeps handing layout and content changes to a caller that asked for them", async () => {
    const onLayout = jest.fn()
    const onContentSizeChange = jest.fn()
    await draw({ onLayout, onContentSizeChange })
    await layOut(844)
    await fill(400)
    expect(onLayout).toHaveBeenCalledTimes(1)
    expect(onContentSizeChange).toHaveBeenCalledWith(390, 400)
  })
})
