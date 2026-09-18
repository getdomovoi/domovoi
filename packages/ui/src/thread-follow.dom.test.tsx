import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { isAtBottom, threadFollowPillText, threadFollowState, useThreadFollow } from "./thread-follow"

afterEach(cleanup)

describe("thread follow state", () => {
  it("is bottom whenever the viewport is at the end, whatever waits", () => {
    expect(threadFollowState({ atBottom: true, unseen: 3, gated: true })).toBe("bottom")
  })

  it("is gate when scrolled up and a decision waits, scrolled otherwise", () => {
    expect(threadFollowState({ atBottom: false, unseen: 0, gated: true })).toBe("gate")
    expect(threadFollowState({ atBottom: false, unseen: 3, gated: false })).toBe("scrolled")
  })

  it("names the pill: the count for new output, the wait for a gate, nothing at the bottom", () => {
    expect(threadFollowPillText("scrolled", 3)).toBe("3 new")
    expect(threadFollowPillText("scrolled", 1)).toBe("1 new")
    expect(threadFollowPillText("scrolled", 0)).toBeUndefined()
    expect(threadFollowPillText("gate", 0)).toBe("Waiting on you")
    expect(threadFollowPillText("bottom", 9)).toBeUndefined()
  })

  it("counts a viewport within the slack as at the bottom", () => {
    expect(isAtBottom({ scrollTop: 1000, clientHeight: 500, scrollHeight: 1520 })).toBe(true)
    expect(isAtBottom({ scrollTop: 900, clientHeight: 500, scrollHeight: 1520 })).toBe(false)
  })
})

function Probe({ itemCount, gated, threadKey = "s1" }: { itemCount: number; gated: boolean; threadKey?: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const follow = useThreadFollow(viewport, { itemCount, gated, threadKey })
  return (
    <div>
      <div data-testid="viewport" ref={viewport} onScroll={follow.onScroll} />
      <output data-testid="state">{follow.state}</output>
      <output data-testid="unseen">{follow.unseen}</output>
      <button type="button" onClick={follow.jumpToBottom}>jump</button>
    </div>
  )
}

function size(element: HTMLElement, scrollHeight: number, clientHeight = 500) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight })
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight })
}

describe("useThreadFollow", () => {
  it("scrolls to the end when output lands while at the bottom", () => {
    const { rerender } = render(<Probe itemCount={3} gated={false} />)
    const viewport = screen.getByTestId("viewport")
    size(viewport, 1000)
    viewport.scrollTop = 500
    rerender(<Probe itemCount={4} gated={false} />)
    expect(viewport.scrollTop).toBe(1000)
    expect(screen.getByTestId("state").textContent).toBe("bottom")
  })

  it("holds still when scrolled up, counts what landed, and offers the ride back", () => {
    const { rerender } = render(<Probe itemCount={3} gated={false} />)
    const viewport = screen.getByTestId("viewport")
    size(viewport, 1000)
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    expect(screen.getByTestId("state").textContent).toBe("scrolled")

    size(viewport, 1400)
    rerender(<Probe itemCount={6} gated={false} />)
    expect(viewport.scrollTop).toBe(100)
    expect(screen.getByTestId("unseen").textContent).toBe("3")

    act(() => { screen.getByRole("button", { name: "jump" }).click() })
    expect(viewport.scrollTop).toBe(1400)
    expect(screen.getByTestId("state").textContent).toBe("bottom")
    expect(screen.getByTestId("unseen").textContent).toBe("0")
  })

  it("does not move the viewport for a gate, and says one is waiting", () => {
    const { rerender } = render(<Probe itemCount={3} gated={false} />)
    const viewport = screen.getByTestId("viewport")
    size(viewport, 1000)
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    size(viewport, 1200)
    rerender(<Probe itemCount={4} gated />)
    expect(viewport.scrollTop).toBe(100)
    expect(screen.getByTestId("state").textContent).toBe("gate")
  })

  it("forgets the count once the person scrolls back to the bottom themselves", () => {
    const { rerender } = render(<Probe itemCount={3} gated={false} />)
    const viewport = screen.getByTestId("viewport")
    size(viewport, 1000)
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    rerender(<Probe itemCount={5} gated={false} />)
    expect(screen.getByTestId("unseen").textContent).toBe("2")
    viewport.scrollTop = 490
    fireEvent.scroll(viewport)
    expect(screen.getByTestId("state").textContent).toBe("bottom")
    expect(screen.getByTestId("unseen").textContent).toBe("0")
  })

  it("treats another session's thread as a fresh scroll, not as new output", () => {
    const { rerender } = render(<Probe itemCount={3} gated={false} threadKey="s1" />)
    const viewport = screen.getByTestId("viewport")
    size(viewport, 1000)
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    size(viewport, 3000)
    rerender(<Probe itemCount={40} gated={false} threadKey="s2" />)
    expect(viewport.scrollTop).toBe(3000)
    expect(screen.getByTestId("unseen").textContent).toBe("0")
    expect(screen.getByTestId("state").textContent).toBe("bottom")
  })
})
