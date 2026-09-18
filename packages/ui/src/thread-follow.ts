import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

// The thread sticks to the bottom only when it is already there. Scrolled up,
// it holds still, and a pill above the composer offers the ride back. Three
// states, driven by the real scroll position: bottom (no pill), scrolled (new
// output arrived below), gate (a decision is waiting below). The gate state
// earns the affordance: while an agent works, output arrives constantly and a
// bare count is noise; what matters is whether the thing that arrived needs a
// decision. Neither state moves the viewport.
export type ThreadFollow = "bottom" | "scrolled" | "gate"

// Within this many pixels of the end counts as at the bottom, so a wheel that
// settles a hair short still follows.
export const atBottomSlack = 24

export function threadFollowState(input: { atBottom: boolean; unseen: number; gated: boolean }): ThreadFollow {
  if (input.atBottom) return "bottom"
  if (input.gated) return "gate"
  return "scrolled"
}

export function threadFollowPillText(state: ThreadFollow, unseen: number): string | undefined {
  if (state === "gate") return "Waiting on you"
  if (state === "scrolled" && unseen > 0) return unseen === 1 ? "1 new" : `${unseen} new`
  return undefined
}

export function isAtBottom(viewport: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - atBottomSlack
}

// itemCount is the number of rows the thread draws; growth while the person
// is at the bottom scrolls to the end, growth while they are scrolled up is
// counted for the pill and the viewport is left alone.
export function useThreadFollow(
  viewport: RefObject<HTMLElement | null>,
  input: { itemCount: number; gated: boolean; threadKey: string },
): { state: ThreadFollow; unseen: number; jumpToBottom: () => void; onScroll: () => void } {
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const atBottomRef = useRef(true)
  const seenCount = useRef(input.itemCount)
  const seenKey = useRef(input.threadKey)

  const onScroll = useCallback(() => {
    const element = viewport.current
    if (!element) return
    const next = isAtBottom(element)
    if (next === atBottomRef.current) return
    atBottomRef.current = next
    setAtBottom(next)
    if (next) setUnseen(0)
  }, [viewport])

  const jumpToBottom = useCallback(() => {
    const element = viewport.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
    setUnseen(0)
  }, [viewport])

  useEffect(() => {
    // Another session's thread is a different scroll, not new output in this one.
    if (seenKey.current !== input.threadKey) {
      seenKey.current = input.threadKey
      seenCount.current = input.itemCount
      jumpToBottom()
      return
    }
    const delta = input.itemCount - seenCount.current
    seenCount.current = input.itemCount
    if (delta <= 0) return
    if (atBottomRef.current) {
      const element = viewport.current
      if (element) element.scrollTop = element.scrollHeight
      return
    }
    setUnseen((count) => count + delta)
  }, [input.itemCount, input.threadKey, jumpToBottom, viewport])

  return { state: threadFollowState({ atBottom, unseen, gated: input.gated }), unseen, jumpToBottom, onScroll }
}
