import { useState } from "react"

import { useWorkspaceConnection } from "./connection-status"
import { cn } from "./lib/utils"

// The design draws exactly two loading states and calls them "skeletons in the
// shape of what is coming, and a line saying which machine is being read". Both
// halves matter: the shape stops the layout jumping when rows arrive, and the
// line stops the shape being a claim that rows are definitely coming. Nothing
// else in the product gets one, because a load short enough not to be seen does
// not need to be drawn.
//
// The bars shimmer, and that is functional rather than decorative by the design
// system's own test. A still grey block is indistinguishable from a real but
// empty row and from a render that has hung; the shimmer says "not yet", and the
// sentence beside it is equally still so it cannot carry that alone. If the read
// stalls, this is the only thing left on screen saying the client is trying.
//
// dv-pulse is the other family, reserved for something that wants a decision,
// and would be the wrong claim here: a skeleton wants nothing. Under reduced
// motion the shimmer stops outright (styles.css sets animation: none on
// .skeleton-bar), because shortening an infinite loop would speed it up; the
// sentence beside the bars carries the state alone.
function Bar({ className, still }: { className?: string, still: boolean }) {
  return <span aria-hidden className={cn(still ? "bg-[var(--skel)]" : "skeleton-bar", "block rounded-sm", className)} />
}

// The bars without the line, for a frame that already names what is coming:
// a dialog drawn while its code loads carries the loaded dialog's own title
// (lazy-surface.tsx), so a sentence here would only repeat it.
export function SkeletonBars({ blocks }: { blocks: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      {Array.from({ length: blocks }, (_, block) => (
        <div key={block} className="flex flex-col gap-2">
          <Bar still={false} className="h-2.5 w-1/3" />
          <Bar still={false} className="h-2 w-full" />
          <Bar still={false} className="h-2 w-2/3" />
        </div>
      ))}
    </div>
  )
}

// Before the hello there is no machine name, only what was dialled. An RPC
// address names its host; the scheme and path say nothing to a reader.
function readingFrom(from: string): string {
  if (!/^(?:wss?|https?):\/\//iu.test(from)) return from
  try {
    return new URL(from).host || from
  } catch {
    return from
  }
}

// Ruled Q344 A: once the first attempt has failed, nothing is being read, so
// the shimmer stops and the line says so, and it stays stopped while the next
// attempt runs under the banner. The shell's banner keeps saying what it is
// doing about it. `from` is the machine being read, or the address dialled.
export function ThreadSkeleton({ from }: { from: string }) {
  const connection = useWorkspaceConnection()
  // A failed attempt schedules the next one (reconnecting) or, refused, says
  // why (authenticationRequired). The shell's connectionError is not read: it
  // outlives a change of target, and a failed manual reconnect also schedules
  // the next attempt.
  const failing = connection !== null && !connection.connected
    && (connection.reconnecting || connection.authenticationRequired !== null)
  // The failure belongs to the target that failed: a new target reads
  // afresh. The shell resets its connection state in an effect after the
  // target changes, so a failure that arrives with a new target is the old
  // one. A target's own failure is one seen after a moment without one.
  const [seen, setSeen] = useState<{ from: string, failed: boolean, clear: boolean }>(
    () => ({ from, failed: failing, clear: !failing }),
  )
  let next = seen
  if (seen.from !== from) next = { from, failed: false, clear: !failing }
  else if (failing && !seen.failed && seen.clear) next = { ...seen, failed: true }
  else if (!failing && !seen.clear) next = { ...seen, clear: true }
  if (next !== seen) setSeen(next)
  const still = next.failed
  const target = readingFrom(from)
  return (
    <div data-testid="thread-skeleton" className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <p role="status" className="font-machine text-mono-xs text-faint">
        {still ? `Not connected. Nothing has been read from ${target} yet.` : `reading the thread from ${target}`}
      </p>
      {[0, 1, 2].map((block) => (
        <div key={block} className="flex flex-col gap-2">
          <Bar still={still} className="h-2.5 w-1/3" />
          <Bar still={still} className="h-2 w-full" />
          <Bar still={still} className="h-2 w-11/12" />
          <Bar still={still} className="h-2 w-2/3" />
        </div>
      ))}
    </div>
  )
}
