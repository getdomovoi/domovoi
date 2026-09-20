import { expect, it } from "vitest"

import { composerPlaceholder, sendHint } from "./composer-keys"

// The design defines this string in its data and renders it nowhere. A send key
// that is Enter alone, with no hint on screen, is a trap, so it is rendered.
it("writes the send hint with the keys of the platform", () => {
  expect(sendHint("darwin")).toBe("↵ to send · ⇧↵ for a new line")
  expect(sendHint("other")).toBe("Enter to send · Shift+Enter for a new line")
})

// Three states, not two: the design's placeholder names the daemon when the
// daemon is what is missing, rather than inviting a message that cannot leave.
it("names what the field is for in each state", () => {
  expect(composerPlaceholder({ offline: true, working: true })).toBe("Cannot send, the daemon is not answering")
  expect(composerPlaceholder({ offline: false, working: true })).toBe("Steer it while it works")
  expect(composerPlaceholder({ offline: false, working: false })).toBe("Reply, or steer the plan")
})
