import { useCallback, useEffect, useId, useRef, useState } from "react"
import { CircleStopIcon, XIcon } from "lucide-react"

import type { RepositoryGitFilterRefusal, RepositoryTrust, ToolInventory } from "@getdomovoi/protocol"

import { Alert, AlertDescription } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { cn } from "./lib/utils"
import { RepositoryTrustSheet, type RepositoryTrustRequest } from "./repository-trust-sheet"
import { awaitsTrust, gitFilterScopeLabel } from "./tool-inventory-model"
import { GrantedWhere, mono } from "./tool-inventory-parts"
import type { ToolInventoryLoad } from "./tool-inventory-view"

// A new session the daemon refused because checking the repository out would
// run a git filter its own Git config sets (design step 15). Domovoi refused,
// not an agent, and nothing ran. Review and trust opens the one trust sheet
// over the files as they are now (ruling Q201 A), and the grant acknowledges
// the git filters the sheet showed (#688); after a grant the card says
// so and waits for the person to start the session again: it never starts by
// itself (ruling Q202 A).
//
// onTrust is given where this client may grant trust (desktop and web, not
// watching) and absent everywhere else, where the card says where trust is
// granted. onStartAgain repeats the refused request; a second refusal comes
// back as a new card from the caller, so only another failure lands here.
export function SessionRefusalCard({
  refusal,
  repository,
  machine,
  machineId,
  loadInventory,
  onTrust,
  onOpenTools,
  onStartAgain,
  onClose,
}: {
  refusal: RepositoryGitFilterRefusal
  // The repository and machine as they were when the refused start was made.
  repository: string
  machine: string
  machineId: string
  loadInventory: (signal: AbortSignal) => Promise<ToolInventory>
  onTrust?: RepositoryTrustRequest | undefined
  onOpenTools: () => void
  onStartAgain: () => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const [reviewing, setReviewing] = useState(false)
  const [inventory, setInventory] = useState<ToolInventoryLoad>({ state: "loading" })
  const [reads, setReads] = useState(0)
  const [trusted, setTrusted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState("")
  const loadRef = useRef(loadInventory)
  loadRef.current = loadInventory
  const { projectId } = refusal

  // The sheet reads the files while it is open, and again when it asks to
  // (the files changed under it). Each read retires the one before it.
  useEffect(() => {
    if (!reviewing) return
    let active = true
    const read = new AbortController()
    setInventory({ state: "loading" })
    loadRef.current(read.signal).then(
      (value) => {
        if (!active) return
        // The review is of the refused repository on the machine that refused
        // it. A read that answers for another one is never offered for trust.
        if (value.repository?.projectId !== projectId || value.machine.id !== machineId) {
          setInventory({ state: "error", message: otherScopeText })
          return
        }
        setInventory({ state: "loaded", inventory: value, readAt: new Date() })
      },
      (cause: unknown) => { if (active) setInventory({ state: "error", message: cause instanceof Error ? cause.message : "The tools could not be read" }) },
    )
    return () => {
      active = false
      read.abort()
    }
  }, [reviewing, reads, projectId, machineId])

  // Only a grant for the refused repository lifts this refusal.
  const granted = useCallback((trust: RepositoryTrust) => {
    if (trust.projectId === refusal.projectId && trust.trust.state === "trusted") setTrusted(true)
  }, [refusal.projectId])

  const startAgain = async () => {
    setStarting(true)
    setStartError("")
    try {
      await onStartAgain()
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : "The session was not started")
    } finally {
      setStarting(false)
    }
  }

  // A trusted refusal is one the daemon holds the filters back from under a
  // grant that did not acknowledge them, or acknowledged others
  // (filters-not-reviewed, filters-changed), so trusting again settles it too.
  const reviewAgain = refusal.trust.state === "trusted"
  const reviewable = !trusted && (reviewAgain || awaitsTrust(refusal.trust))
  const named = refusal.drivers.map((driver) => driver.name).filter((name, index, all) => all.indexOf(name) === index)

  return (
    // The design draws a refusal with the danger family (step 15): Domovoi
    // refused, which is not inventory state, so it does not read as one.
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border border-danger-border bg-danger-background">
      {/* The dismiss button stays on the title row when a narrow card wraps. */}
      <div className="flex items-start gap-2 py-2 pr-2 pl-[15px]">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <span data-slot="refusal-dot" className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
          <h2 id={titleId} className="m-0 text-[13px] font-semibold text-danger-foreground">Domovoi did not start this session</h2>
          <span className="flex-1" />
          <span className={cn(mono, "text-[10.5px] text-danger-dim")}>refused · untrusted git filter</span>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" className="text-danger-foreground" onClick={onClose}><XIcon /></Button>
      </div>
      <div className="flex flex-col gap-2 px-[15px] pb-3 text-[12px] leading-[1.6] text-danger-foreground">
        <p className="m-0">{refusalSentence(refusal, named, repository, machine, trusted)}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-[11.5px] text-danger-dim">It names</span>
          {refusal.drivers.map((driver) => (
            <code key={`${driver.scope}\u0000${driver.name}`} className={cn(mono, "text-[11px] break-all text-danger-foreground")}>
              {`${driver.name} · ${gitFilterScopeLabel[driver.scope]}`}
            </code>
          ))}
          {refusal.omittedDrivers > 0 ? <span className="text-[11.5px] text-danger-dim">{`and ${refusal.omittedDrivers} more`}</span> : null}
        </div>
        <p className="m-0 text-[11.5px] text-danger-dim">Nothing from the repository ran.</p>
      </div>
      {trusted ? (
        // After a grant the design draws the trusted line on the card ground
        // with a success dot.
        <p className="m-0 flex items-center gap-2.5 border-t border-danger-border bg-card px-[15px] py-2.5 text-[12px] text-strong">
          <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
          {`Trusted on ${machine}. Nothing has started yet.`}
        </p>
      ) : null}
      {startError ? (
        <Alert variant="destructive" className="rounded-none border-x-0 border-b-0">
          <CircleStopIcon />
          <AlertDescription>{startError}</AlertDescription>
        </Alert>
      ) : null}
      <div className={cn("flex flex-wrap items-center gap-3 px-[15px] py-2.5", trusted ? "bg-card" : "border-t border-danger-border")}>
        {trusted ? (
          <Button size="sm" disabled={starting} onClick={() => { void startAgain() }}>Start the session again</Button>
        ) : null}
        {reviewable && onTrust ? <Button size="sm" onClick={() => setReviewing(true)}>{reviewAgain ? "Review and trust again" : "Review and trust"}</Button> : null}
        <Button size="sm" variant="outline" className="border-danger-border bg-transparent text-danger-foreground" onClick={onOpenTools}>Open Tools</Button>
        {reviewable && !onTrust ? <GrantedWhere /> : null}
      </div>
      {onTrust ? (
        <RepositoryTrustSheet
          open={reviewing}
          onOpenChange={setReviewing}
          inventory={inventory}
          onTrust={onTrust}
          onReload={() => setReads((current) => current + 1)}
          onTrusted={granted}
        />
      ) : null}
    </section>
  )
}

const otherScopeText = "Domovoi read the tools of another project or machine than the one that refused this session, so they are not shown for review."

// "the sops filter driver", "the sops and crypt filter drivers and 2 more".
function driversPhrase(named: readonly string[], omitted: number): { phrase: string; many: boolean } {
  const list = named.length <= 1
    ? named.join("")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
  const many = named.length + omitted > 1
  return { phrase: `the ${list} ${many ? "filter drivers" : "filter driver"}${omitted > 0 ? ` and ${omitted} more` : ""}`, many }
}

// What the refusal says, by the trust the daemon read with it. Trusted means
// the filters are held back under the grant read now: its client did not show
// them, showed others, or trust changed while the start ran. The refusal
// carries no finer reason, so the sentence names no cause, only what settles
// it. Once the person trusts from this card, the trust clause no longer holds
// and the line below says so instead.
function refusalSentence(refusal: RepositoryGitFilterRefusal, named: readonly string[], repository: string, machine: string, grantedHere: boolean): string {
  const { phrase, many } = driversPhrase(named, refusal.omittedDrivers)
  const lead = `Checking out ${repository} would run ${phrase}`
  if (grantedHere) return `${lead}.`
  const { trust } = refusal
  if (trust.state === "trusted") {
    return `${lead}. ${repository} is trusted on ${machine}, but its Git filters are held back until they are reviewed again.`
  }
  if (trust.reason === "cannot-trust") return `${lead}, and ${repository} cannot be trusted on ${machine}.`
  return `${lead}, which ${many ? "are" : "is"} not trusted on ${machine}.`
}
