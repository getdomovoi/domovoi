import { threadFollowState, type ThreadFollow } from "@getdomovoi/protocol"
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

// The three follow states and the pill copy live in protocol, shared with the
// phone; this file is the DOM half: reading the viewport and moving it.

// Within this many pixels of the end counts as at the bottom, so a wheel that
// settles a hair short still follows.
export const atBottomSlack = 24

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
