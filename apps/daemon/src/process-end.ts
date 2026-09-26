import type { EventEmitter } from "node:events"

// Node emits "exit" while a child's stdio may still be open, and a crashing
// CLI's last stderr line, the one that says why, is usually still in flight.
// The end is reported at "close", once stdio has drained. A grandchild that
// inherited the pipes can hold "close" off indefinitely, so "exit" falls back
// after a short grace.
export const processCloseGraceMs = 500

export function onProcessEnd(
  child: EventEmitter,
  listener: (code: number | null, signal: NodeJS.Signals | null) => void,
): void {
  let ended = false
  let fallback: ReturnType<typeof setTimeout> | undefined
  const end = (code: number | null, signal: NodeJS.Signals | null) => {
    if (ended) return
    ended = true
    if (fallback !== undefined) clearTimeout(fallback)
    listener(code, signal)
  }
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    fallback = setTimeout(() => end(code, signal), processCloseGraceMs)
    fallback.unref?.()
  })
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => end(code, signal))
}
