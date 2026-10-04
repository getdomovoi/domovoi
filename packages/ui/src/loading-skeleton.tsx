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

// Ruled Q344 A: once the first attempt has failed, nothing is being read, so
// the shimmer stops and the line says so. notConnectedTo names the host the
// client dialled. The shell's banner keeps saying what it is doing about it.
export function ThreadSkeleton({ reading, notConnectedTo }: { reading: string, notConnectedTo?: string | undefined }) {
  const still = notConnectedTo !== undefined
  return (
    <div data-testid="thread-skeleton" className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <p role="status" className="font-machine text-mono-xs text-faint">
        {still ? `Not connected. Nothing has been read from ${notConnectedTo} yet.` : reading}
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
