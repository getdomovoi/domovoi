import { useRef, useState, type MouseEvent } from "react"
import { CircleStopIcon } from "lucide-react"
import type { ApprovalDecision, ApprovalRequest } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { cn } from "./lib/utils"
import { restoreFocusAfterUpdate } from "./restore-focus"

export function ApprovalCard({
  approval,
  onResolve,
  surface,
  watching = false,
  connected,
  refusal,
  deciding = false,
}: {
  approval: ApprovalRequest
  onResolve: (
    decision: ApprovalDecision,
    explanation?: string,
  ) => void
  surface: "desktop" | "web"
  // A watching device is shown the gate in full and answers nothing. The
  // daemon refuses its decisions; the card shows them locked.
  watching?: boolean
  // A decision made with no daemon to hear it goes nowhere, so the card holds
  // every decision until the connection is back and says why.
  connected: boolean
  // The daemon's answer when it refused the last decision on this gate, such
  // as a checkpoint it could not take. Shown in its words: the cause is
  // whatever the daemon reported, and nothing more.
  refusal?: string | undefined
  // Set while a decision this client sent is still waiting for its answer.
  // Every decision holds until then, so a second press cannot send another,
  // or land on the next gate drawn in this one's place.
  deciding?: boolean | undefined
}) {
  const explainTriggerRef = useRef<HTMLButtonElement>(null)
  const [explainOpen, setExplainOpen] = useState(false)
  const [explanation, setExplanation] = useState("")
  // A watching device's decisions are refused by the daemon, and a
  // disconnected one's reach nothing: both see the decisions locked.
  const locked = watching || !connected || deciding
  const decide = (decision: ApprovalDecision, why?: string) => {
    if (locked) return
    onResolve(decision, why)
  }
  // The second click of a double click is not a second decision.
  const press = (decision: ApprovalDecision) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1) return
    decide(decision)
  }

  // The desktop card is the Desktop v2 gate; the web card keeps the signed web
  // design's header, which draws no facts.
  const desktop = surface === "desktop"
  // Ruling pending (questions.md): the design folds the facts behind What
  // does this touch?. For a file edit the command reads only the tool's name
  // and Affects is the fact that names the file, so the disclosure starts
  // open and nothing sits behind a click until that is decided.
  const [factsOpen, setFactsOpen] = useState(true)
  const factsId = `approval-facts-${approval.id}`
  // Agent and mode ride the header line instead of the grid, the way the design
  // draws the gate. Nothing is dropped: every fact is on the card.
  const facts = [
    ["Machine", approval.machine],
    ["Working dir", approval.directory],
    ["Affects", approval.affects],
    ["Network", approval.network],
    ["Estimated", approval.estimatedDuration],
  ]
  // The design draws no Hard gate badge on the desktop header, so the risk
  // rides the meta line: it is an approval fact and stays on the card.
  const meta = `${approval.agent} · ${approval.mode}${desktop && approval.risk === "hard-gate" ? " · hard gate" : ""}`
  const closeExplanation = () => {
    setExplainOpen(false)
    setExplanation("")
    restoreFocusAfterUpdate(explainTriggerRef)
  }

  return (
    <Alert
      variant="warning"
      className={cn(
        "mx-auto max-w-3xl rounded-xl",
        desktop
          ? "gap-0 overflow-hidden border-[1.5px] border-warning p-0 shadow-[0_18px_44px_color-mix(in_oklab,var(--warning)_14%,transparent)]"
          : "gap-3 p-4",
      )}
    >
      {desktop ? null : <CircleStopIcon />}
      {desktop ? (
        <AlertTitle className="flex items-center gap-[11px] px-4 pt-3.5 pb-3 text-[15px] font-semibold tracking-[-.01em] text-warn-foreground">
          {/* The design's pulse: a gate is the one thing on screen that
              wants a decision. Still when the reader asks for less motion. */}
          <span aria-hidden className="relative inline-flex size-[9px] shrink-0">
            <span className="absolute inset-0 rounded-full bg-warning/60 motion-safe:animate-ping motion-safe:[animation-duration:2.4s]" />
            <span className="relative size-[9px] rounded-full bg-warning" />
          </span>
          Waiting on your decision
          <span className="ml-auto font-machine text-[10.5px] font-normal tracking-normal text-warn-dim">{meta}</span>
        </AlertTitle>
      ) : (
        <AlertTitle className="flex items-center gap-2 text-[12.5px]">
          {approval.risk === "hard-gate" ? "Approval required, hard gate" : "Approval required"}
          <span className="ml-auto font-machine text-[10.5px] font-normal text-warn-dim">{meta}</span>
        </AlertTitle>
      )}
      <AlertDescription className={cn("col-span-full flex flex-col", desktop ? "gap-3 px-4 pb-3.5" : "gap-3")}>
        <p className="m-0 text-[13px] font-medium text-warn-foreground">{approval.operation}</p>
        <code
          className={cn(
            "break-all whitespace-pre-wrap bg-warn-deep font-machine text-warn-foreground",
            desktop ? "rounded-lg px-[15px] py-[13px] text-[13.5px]" : "rounded-md px-3 py-2 text-[11px]",
          )}
        >
          {approval.command}
        </code>
        {desktop ? null : (
          <dl className="m-0 grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-[11px]">
            {facts.map(([label, value]) => (
              <div className="contents" key={label}>
                <dt className="text-warn-dim">{label}</dt>
                <dd className="m-0 min-w-0 break-words font-machine text-warn-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {refusal ? (
          // The daemon's refusal of the last decision on this gate, such as a
          // checkpoint it could not take, in the design's danger block.
          <p role="alert" className="m-0 flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-background px-[13px] py-[11px] text-[12.5px] leading-[1.55] text-danger-foreground">
            <span aria-hidden className="mt-1.5 size-[7px] shrink-0 rounded-full bg-destructive" />
            {refusal}
          </p>
        ) : null}
        {!watching && !connected ? (
          // The client knows it is disconnected, not why, so no cause is named.
          <p className="text-[11px] text-warn-dim">Cannot answer this gate while this client is disconnected from the daemon.</p>
        ) : null}
        {/* The decisions are held while the answer is out; this says why. */}
        {deciding && !watching && connected ? (
          <p role="status" className="text-[11px] text-warn-dim">Sending your decision</p>
        ) : null}
        {explainOpen && !watching ? (
          // Ruled Q339 A. The daemon keeps the note on the receipt; no adapter
          // passes it to the provider, which hears a plain denial, so the copy
          // promises the agent nothing.
          <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-background/40 p-3">
            <label htmlFor={`denial-${approval.id}`} className="text-[11px] font-medium text-warn-foreground">
              Note on this denial
            </label>
            <p id={`denial-${approval.id}-help`} className="m-0 text-[11px] text-warn-dim">
              Kept on the receipt. The agent is told only that you denied it.
            </p>
            <Input
              id={`denial-${approval.id}`}
              aria-describedby={`denial-${approval.id}-help`}
              autoFocus
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  event.stopPropagation()
                  closeExplanation()
                  return
                }
                if (event.key === "Enter" && explanation.trim()) {
                  decide("deny-explain", explanation.trim())
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeExplanation}>Cancel</Button>
              <Button
                variant="warning"
                size="sm"
                disabled={locked || !explanation.trim()}
                onClick={() => decide("deny-explain", explanation.trim())}
              >
                Deny with this note
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {/* Ruled Q372 A: a watching device sees the decisions as drawn,
                locked, and the note says why. */}
            <Button variant="warning" size="sm" className={cn(desktop && "h-[38px] px-[18px] text-[13px] font-semibold")} disabled={locked} onClick={press("allow-once")}>Allow once</Button>
            {/* Ruled 2026-09-24: the daemon refuses a standing rule on a hard gate
                and for a request it could not resolve, so the card offers none.
                Ruled Q371 A: a rule matches this execution record, not a
                command family, so the label names "this command" on desktop
                and web rather than the design's "prisma migrate". The tablet
                draws its own card and still says "Always here". */}
            {approval.execution.state === "resolved" && approval.risk !== "hard-gate" ? (
              <Button variant="outline" size="sm" className={cn(outline, "text-warn-foreground", desktop && "h-[38px] px-[15px] text-[12.5px]")} disabled={locked} onClick={press("always-project")}>Always for this command here</Button>
            ) : null}
            <Button variant="outline" size="sm" className={cn(outline, "text-warn-dim", desktop && "h-[38px] px-[15px] text-[12.5px]")} disabled={locked} onClick={press("deny")}>Deny</Button>
            {watching ? (
              <span className="text-[11px] text-warn-dim">Locked, this client is watching only.</span>
            ) : (
              <Button ref={explainTriggerRef} variant="ghost" size="sm" className="text-warn-dim" disabled={locked} onClick={() => setExplainOpen(true)}>Deny with a note</Button>
            )}
            {/* Only a connected tab with full access holds the gate. */}
            {surface === "web" && !locked ? <span className="ml-auto font-machine text-[10.5px] text-warn-dim">This tab holds the gate</span> : null}
            {/* Reading the facts decides nothing, so a locked card still
                opens and folds them. */}
            {desktop ? (
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={factsOpen}
                aria-controls={factsId}
                className="ml-auto px-1 text-[11px] font-normal text-warn-dim hover:bg-transparent hover:text-warn-foreground aria-expanded:bg-transparent aria-expanded:text-warn-dim dark:hover:bg-transparent"
                onClick={() => setFactsOpen((open) => !open)}
              >
                {factsOpen ? "Hide what this touches" : "What does this touch?"}
              </Button>
            ) : null}
          </div>
        )}
      </AlertDescription>
      {desktop && factsOpen ? (
        // The design's facts: three columns under the decisions, flush with
        // the card's edges, divided by the gate's own border colour.
        <dl id={factsId} className="col-span-full m-0 grid grid-cols-1 gap-px border-t border-warn-border bg-warn-border sm:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label} className="bg-warn-background px-3.5 py-2.5">
              <dt className="text-[10.5px] tracking-[.13em] text-warn-dim uppercase">{label}</dt>
              <dd className="m-0 mt-1 min-w-0 break-words font-machine text-[10.5px] leading-[1.4] text-warn-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Alert>
  )
}

// The design outlines Always and Deny in the gate's own border, on no fill.
const outline = "border-warn-border bg-transparent hover:bg-warn-deep dark:border-warn-border dark:bg-transparent dark:hover:bg-warn-deep"
