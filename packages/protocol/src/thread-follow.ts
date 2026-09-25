// A thread sticks to the bottom only when it is already there. Scrolled up,
// it holds still, and a pill above the composer offers the ride back. Three
// states, driven by the real scroll position, on every surface with a thread:
// bottom (no pill), scrolled (output arrived below), gate (a decision is
// waiting below). Away from the bottom the pill is always there, because a
// streaming reply grows one row instead of adding rows, so a count can sit at
// zero while the thread keeps moving. The count is the better label when there
// is one; without it the pill still names the ride back. A gate says so
// outright, since a decision outranks a count. Neither state moves the viewport.
export type ThreadFollow = "bottom" | "scrolled" | "gate"

export function threadFollowState(input: { atBottom: boolean; unseen: number; gated: boolean }): ThreadFollow {
  if (input.atBottom) return "bottom"
  if (input.gated) return "gate"
  return "scrolled"
}

export function threadFollowPillText(state: ThreadFollow, unseen: number): string | undefined {
  if (state === "gate") return "Waiting on you"
  if (state === "bottom") return undefined
  if (unseen === 0) return "Jump to latest"
  return unseen === 1 ? "1 new" : `${unseen} new`
}
