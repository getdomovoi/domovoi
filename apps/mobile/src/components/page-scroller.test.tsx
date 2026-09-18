import { describe, expect, it, jest } from "@jest/globals"
import { RefreshControl, ScrollView, Text } from "react-native"
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
async function scrollTo(y: number, viewport: number, content: number) {
  await fireEvent.scroll(scroller(), {
    nativeEvent: { contentOffset: { x: 0, y }, layoutMeasurement: { width: 390, height: viewport }, contentSize: { width: 390, height: content } },
  })
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

  // The design system hides scrollbars on touch outright. The platform draws
  // its own overlay indicator, so one from the app is a second one.
  it("draws no scroll indicator of its own", async () => {
    await draw()
    await layOut(844)
    await fill(1600)
    expect(scroller().props.showsVerticalScrollIndicator).toBe(false)
  })

  // A thread reads newest-last. When a reply lands the person is waiting for
  // it at the bottom, so the scroller goes there; when nothing grew, it stays
  // where the person put it.
  it("follows the end when content grows and it was asked to", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    await draw({ followEnd: true })
    await layOut(844)
    await fill(1200)
    expect(scrollToEnd).toHaveBeenCalledTimes(1)

    await fill(1600)
    expect(scrollToEnd).toHaveBeenCalledTimes(2)

    await fill(1600)
    expect(scrollToEnd).toHaveBeenCalledTimes(2)
    scrollToEnd.mockRestore()
  })

  // Following is for a person waiting at the bottom. One who scrolled up to
  // read turn 3 is not waiting, and moving the viewport under them is the one
  // moment they most need it not to move. Back at the bottom, following resumes.
  it("holds still when the person scrolled up, and follows again once they are back at the bottom", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    await draw({ followEnd: true })
    await layOut(844)
    await fill(1200)
    expect(scrollToEnd).toHaveBeenCalledTimes(1)

    await scrollTo(100, 844, 1200)
    await fill(1600)
    expect(scrollToEnd).toHaveBeenCalledTimes(1)

    await scrollTo(756, 844, 1600)
    await fill(2000)
    expect(scrollToEnd).toHaveBeenCalledTimes(2)
    scrollToEnd.mockRestore()
  })

  it("tells the screen whether it is at the bottom", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    const onAtEndChange = jest.fn()
    await draw({ followEnd: true, onAtEndChange })
    await layOut(844)
    await fill(1200)
    await scrollTo(100, 844, 1200)
    expect(onAtEndChange).toHaveBeenLastCalledWith(false)
    await scrollTo(356, 844, 1200)
    expect(onAtEndChange).toHaveBeenLastCalledWith(true)
    scrollToEnd.mockRestore()
  })

  it("leaves the scroll where it is when not asked to follow", async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => {})
    await draw()
    await layOut(844)
    await fill(1600)
    expect(scrollToEnd).not.toHaveBeenCalled()
    scrollToEnd.mockRestore()
  })
})
