export function restoreFocusAfterUpdate(
  target: { current: { focus(): void } | null },
  schedule: (callback: () => void) => void = (callback) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => callback())
    } else {
      queueMicrotask(callback)
    }
  },
): void {
  schedule(() => target.current?.focus())
}
