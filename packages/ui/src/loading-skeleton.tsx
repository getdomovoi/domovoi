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
function Bar({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton-bar block rounded-sm", className)} />
}

export function SessionListSkeleton({ reading }: { reading: string }) {
  return (
    <div data-testid="session-list-skeleton" className="flex min-h-0 flex-1 flex-col">
      {/* Five rows because the rail draws five. Fewer would settle upward as
          real sessions arrive, which is the jump the shape exists to stop. */}
      <div className="flex flex-col gap-[9px] px-2.5 py-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex gap-[9px] px-1 py-2">
            <Bar className="mt-1 size-1.5 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Bar className="h-2.5 w-full" />
              <Bar className="h-2 w-1/2" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <p role="status" className="border-t px-3 py-2 font-machine text-mono-xs text-faint">
        {reading}
      </p>
    </div>
  )
}

export function ThreadSkeleton({ reading }: { reading: string }) {
  return (
    <div data-testid="thread-skeleton" className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <p role="status" className="font-machine text-mono-xs text-faint">{reading}</p>
      {[0, 1, 2].map((block) => (
        <div key={block} className="flex flex-col gap-2">
          <Bar className="h-2.5 w-1/3" />
          <Bar className="h-2 w-full" />
          <Bar className="h-2 w-11/12" />
          <Bar className="h-2 w-2/3" />
        </div>
      ))}
    </div>
  )
}
