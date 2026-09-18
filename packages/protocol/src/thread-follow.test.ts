import { describe, expect, it } from "vitest"

import { threadFollowPillText, threadFollowState } from "./thread-follow.js"

describe("thread follow", () => {
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
})
