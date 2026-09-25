// The shell collapses the dock when there is genuinely no room for the thread
// and the dock side by side. A ResizeObserver reports once the moment it starts
// observing, and on that first pass the shell has not been laid out, so its
// width is zero. Zero is not a narrow window, it is an unmeasured one, and
// acting on it throws away a pin the reader set on purpose.
export const dockSideBySideMinimumWidth = 1_080

export function shouldCollapseDockForWidth(width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false
  return width < dockSideBySideMinimumWidth
}
