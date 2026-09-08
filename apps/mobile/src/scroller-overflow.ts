// A screen with nothing below the fold should not rubber-band. The bounce is a
// signal that there is more to see, and on a screen that fits it reads as the
// app being broken rather than as slack.
//
// Which screens those are is not something to write down. It is content height
// against viewport height, and it moves with dynamic type, a longer machine
// name, a smaller device and the keyboard opening. It is measured instead.

// Layout arrives fractional, so a content box a third of a point taller than
// its viewport is rounding rather than overflow. It has to be more than a whole
// point taller before there is anything to scroll to.
export const overflowSlack = 1

export function scrollerScrolls(input: {
  // Both are undefined until the scroller has been laid out and has measured
  // its content. Scrolling stays on until then: a screen locked by a
  // measurement that never arrived is worse than one that bounces.
  content: number | undefined
  viewport: number | undefined
  // The pull is the control. A refreshing scroller has to bounce whether or not
  // it overflows, because there is no other way to reach it.
  pullToRefresh: boolean
}): boolean {
  if (input.pullToRefresh) return true
  if (input.content === undefined || input.viewport === undefined) return true
  return input.content - input.viewport > overflowSlack
}
