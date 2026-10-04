import { useRef, useState, type MouseEvent } from "react"
import { CircleStopIcon } from "lucide-react"
import type { ApprovalDecision, ApprovalRequest } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
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

  // Agent and mode ride the header line instead of the grid, the way the design
  // system draws the gate. Nothing is dropped: a desktop shows every fact.
  const facts = [
    ["Machine", approval.machine],
    ["Directory", approval.directory],
    ["Affects", approval.affects],
    ["Network", approval.network],
    ["Est. duration", approval.estimatedDuration],
  ]
  const closeExplanation = () => {
    setExplainOpen(false)
    setExplanation("")
    restoreFocusAfterUpdate(explainTriggerRef)
  }

  return (
    <Alert variant="warning" className="mx-auto max-w-3xl gap-3 rounded-xl p-4">
      <CircleStopIcon />
      <AlertTitle className="flex items-center gap-2 text-[12.5px]">
        {surface === "web" && approval.risk === "hard-gate" ? "Approval required, hard gate" : "Approval required"}
        {surface === "desktop" && approval.risk === "hard-gate" ? <Badge variant="warning">Hard gate</Badge> : null}
        <span className="ml-auto font-machine text-[10.5px] font-normal text-warn-dim">
          {approval.agent} · {approval.mode}
        </span>
      </AlertTitle>
      <AlertDescription className="col-span-full flex flex-col gap-3">
        <p className="text-[13px] font-medium text-warn-foreground">{approval.operation}</p>
        <code className="break-all whitespace-pre-wrap rounded-md bg-warn-deep px-3 py-2 font-machine text-[11px] text-warn-foreground">
          {approval.command}
        </code>
        <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          {facts.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-warn-dim">{label}</dt>
              <dd className="m-0 min-w-0 break-words font-machine text-warn-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {refusal ? (
          <p role="alert" className="m-0 rounded-md border border-danger-border bg-danger-background px-3 py-2 text-[11.5px] leading-[1.5] text-danger-foreground">
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
            <Button variant="warning" size="sm" disabled={locked} onClick={press("allow-once")}>Allow once</Button>
            {/* Ruled 2026-09-24: the daemon refuses a standing rule on a hard gate
                and for a request it could not resolve, so the card offers none.
                Ruled Q371 A: a rule matches this execution record, not a
                command family, so the label names "this command" on desktop
                and web rather than the design's "prisma migrate". The tablet
                draws its own card and still says "Always here". */}
            {approval.execution.state === "resolved" && approval.risk !== "hard-gate" ? (
              <Button variant="outline" size="sm" disabled={locked} onClick={press("always-project")}>Always for this command here</Button>
            ) : null}
            <Button variant="outline" size="sm" disabled={locked} onClick={press("deny")}>Deny</Button>
            {watching ? (
              <span className="text-[11px] text-warn-dim">Locked, this client is watching only.</span>
            ) : (
              <Button ref={explainTriggerRef} variant="ghost" size="sm" className="text-warn-dim" disabled={locked} onClick={() => setExplainOpen(true)}>Deny with a note</Button>
            )}
            {/* Only a connected tab with full access holds the gate. */}
            {surface === "web" && !locked ? <span className="ml-auto font-machine text-[10.5px] text-warn-dim">This tab holds the gate</span> : null}
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}
