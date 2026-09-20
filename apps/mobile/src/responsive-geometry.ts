export function responsiveGeometry(input: {
  width: number
  height: number
  topInset: number
  bottomInset: number
  fontScale: number
}) {
  const compact = input.width < 360
  const scale = Math.min(1.4, Math.max(1, input.fontScale))
  return {
    sideInset: compact ? 10 : 14,
    bottomInset: input.bottomInset > 0 ? input.bottomInset : compact ? 10 : 14,
    keyboardOffset: input.topInset,
    minimumBarHeight: Math.ceil(54 * scale),
  }
}
