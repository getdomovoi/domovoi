import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { FloatingSurface } from "./floating-surface"

afterEach(cleanup)

// The surface follows its anchor while a pane scrolls, and measuring the anchor
// forces layout. A thread scroll fires many events per frame, so the test drives
// frames by hand to see how many measurements one burst costs.
const pendingFrames: FrameRequestCallback[] = []
let realRequestAnimationFrame: typeof globalThis.requestAnimationFrame

beforeEach(() => {
  realRequestAnimationFrame = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    pendingFrames.push(callback)
    return pendingFrames.length
  }) as typeof globalThis.requestAnimationFrame
})

afterEach(() => {
  pendingFrames.length = 0
  globalThis.requestAnimationFrame = realRequestAnimationFrame
})

function flushFrames() {
  act(() => { for (const frame of pendingFrames.splice(0)) frame(0) })
}

function Probe() {
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button type="button" ref={trigger} data-testid="trigger">open</button>
      <FloatingSurface open onClose={() => {}} label="Modes" trigger={trigger}>
        <div>Plan</div>
      </FloatingSurface>
    </div>
  )
}

function countAnchorMeasurements(anchor: HTMLElement) {
  const reads = { count: 0 }
  anchor.getBoundingClientRect = () => {
    reads.count += 1
    return { top: 100, bottom: 130, left: 40, right: 200, width: 160, height: 30, x: 40, y: 100, toJSON: () => ({}) } as DOMRect
  }
  return reads
}

describe("FloatingSurface", () => {
  it("measures the anchor once for a burst of scroll events in one frame", () => {
    render(<Probe />)
    const reads = countAnchorMeasurements(screen.getByTestId("trigger"))
    for (let event = 0; event < 5; event += 1) fireEvent.scroll(window)
    expect(reads.count).toBe(1)
  })

  it("measures again on the next frame, so it rests where the anchor rests", () => {
    render(<Probe />)
    const reads = countAnchorMeasurements(screen.getByTestId("trigger"))
    for (let event = 0; event < 5; event += 1) fireEvent.scroll(window)
    flushFrames()
    expect(reads.count).toBe(2)
  })

  it("still shows the surface and its contents", () => {
    render(<Probe />)
    expect(screen.getByRole("group", { name: "Modes" })).not.toBeNull()
    expect(screen.getByText("Plan")).not.toBeNull()
  })
})
