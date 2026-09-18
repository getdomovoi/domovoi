// A thread sticks to the bottom only when it is already there. Scrolled up,
// it holds still, and a pill above the composer offers the ride back. Three
// states, driven by the real scroll position, on every surface with a thread:
// bottom (no pill), scrolled (new output arrived below), gate (a decision is
// waiting below). The gate state earns the affordance: while an agent works,
// output arrives constantly and a bare count is noise; what matters is whether
// the thing that arrived needs a decision. Neither state moves the viewport.
export type ThreadFollow = "bottom" | "scrolled" | "gate"

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
