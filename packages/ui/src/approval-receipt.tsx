import type { ThreadItem } from "@getdomovoi/protocol"
import { CheckIcon, CircleSlashIcon } from "lucide-react"

import { cn } from "./lib/utils"

type Receipt = Extract<ThreadItem, { kind: "receipt" }>

// What a receipt has to answer: what was decided, whether the work is
// revertible, and whether the decision outlives this moment. The design also
// shows how long the command took. Since 5ee18251 the daemon sets ranForMs on
// an allow's receipt once the agent reports the allowed command's item
// complete: wall-clock time from the decision to that report. It stays absent
// when the turn ends or the daemon restarts first, and on older receipts.
export function decisionSummary(receipt: Receipt): { verdict: string, rule: string } {
  switch (receipt.decision) {
    case "allow-once":
      return {
        verdict: "Allowed once",
        rule: "No rule was saved, so the next request like it asks again.",
      }
    case "always-project":
      return {
        verdict: "Allowed, and saved as a rule for this project",
        rule: "Later requests matching it run without asking. Retire the rule in Rules.",
      }
    case "deny":
      return { verdict: "Denied", rule: "Nothing ran, and no rule was saved." }
    case "deny-explain":
      return {
        verdict: "Denied with a note",
        // The daemon records the note on the receipt. No adapter passes it to
        // the provider, which answers with a generic denial, so this cannot
        // claim the agent heard it. The card calls it a note (ruled Q339 A).
        rule: "Nothing ran. The note is recorded here; the agent was told only that you denied it.",
      }
  }
}

// Since 5ee18251 a person's allow takes a checkpoint before the command runs,
// and the receipt carries that checkpoint's commit; the same commit appears as
// a checkpoint row in the thread. An allow in a session with no worktree
// records "unavailable". A denial, and an allow written before that change,
// carry the session's base commit or "unavailable". Restoring only ever
// touches files in the worktree, so the note says so.
//
// Nothing on the receipt says which of those it holds, so checkpointTaken is
// set only when the thread shows the checkpoint row taken at this decision.
export function recoveryNote(receipt: Receipt, checkpointTaken = false): string {
  const ran = receipt.ranForMs === undefined ? undefined : runTime(receipt.ranForMs)
  if (checkpointTaken && receipt.checkpoint !== "unavailable") {
    const taken = `Checkpoint ${shortReference(receipt.checkpoint, checkpointRowLength)} was taken first${ran ? `, then it ran in ${ran}` : ""}.`
    return `${taken} Going back to it restores files in the worktree; it cannot undo effects outside it.`
  }
  const ranNote = ran ? ` It ran in ${ran}.` : ""
  if (receipt.checkpoint === "unavailable") {
    return `No reference was recorded for this session, so Domovoi has nothing to compare this against.${ranNote}`
  }
  return `Recorded against ${shortReference(receipt.checkpoint)}. Going back to it restores files in the worktree; it cannot undo effects outside it.${ranNote}`
}

// The design's clock: "38s", "4m 18s", and hours with minutes past that.
export function runTime(ms: number): string {
  if (ms < 1_000) return "under 1s"
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

// The checkpoint a person's allow took is recorded twice at the same moment:
// on the receipt, and as a checkpoint row with that commit. A base commit an
// older receipt carries may match an earlier row, never one at the decision.
export function receiptCheckpointTaken(receipt: Receipt, thread: readonly ThreadItem[]): boolean {
  return thread.some((item) =>
    item.kind === "checkpoint"
    && item.sessionId === receipt.sessionId
    && item.commit === receipt.checkpoint
    && item.createdAt === receipt.createdAt
  )
}

// Only a full commit SHA is safe to shorten. Every other id the daemon may put
// here is a name, and half a name is a different name.
function shortReference(reference: string, length = 7): string {
  return /^[0-9a-f]{40}$/.test(reference) ? reference.slice(0, length) : reference
}

// A checkpoint the allow took is named as its row in the thread names it: the
// daemon labels that row with the commit's first 8 characters.
const checkpointRowLength = 8

export function ApprovalReceipt({
  receipt,
  checkpointTaken = false,
  className,
}: {
  receipt: Receipt
  // Set when the thread shows the checkpoint this allow took; see
  // receiptCheckpointTaken.
  checkpointTaken?: boolean
  className?: string
}) {
  const denied = receipt.decision === "deny" || receipt.decision === "deny-explain"
  const { verdict, rule } = decisionSummary(receipt)
  // Ruling Q424 A: the paired device's label the daemon wrote on the receipt
  // names who decided, before the client kind, as the design's receipt line
  // reads. A receipt without one (the daemon credential, or a row written
  // before the field) names the client alone.
  const decider = receipt.device ? `${receipt.device.label} · ${receipt.client}` : receipt.client
  const named = !denied && checkpointTaken && receipt.checkpoint !== "unavailable"
  const meta = denied ? "" : [
    named ? shortReference(receipt.checkpoint, checkpointRowLength) : undefined,
    receipt.ranForMs === undefined ? undefined : runTime(receipt.ranForMs),
  ].filter(Boolean).join(" · ")
  const decidedFrom = receipt.connectionId
    ? `${decider}, connection ${receipt.connectionId}`
    : receipt.clientId
      ? `${decider}, declared client ${receipt.clientId}`
      : decider

  return (
    <section
      aria-label="Decision receipt"
      className={cn(
        "mx-auto flex max-w-3xl flex-col gap-1.5 rounded-xl border px-4 py-3",
        denied ? "border-border bg-card" : "border-info-border bg-info-background",
        className,
      )}
    >
      <h3 className={cn("flex items-center gap-2 text-[12.5px] font-semibold", denied ? "text-strong" : "text-info-foreground")}>
        {denied ? <CircleSlashIcon aria-hidden className="size-3.5" /> : <CheckIcon aria-hidden className="size-3.5" />}
        {verdict}
        {meta ? <span className="ml-auto font-mono text-[10.5px] font-normal text-info-dim">{meta}</span> : null}
      </h3>
      <p className={cn("m-0 font-mono text-[11px]", denied ? "text-muted-foreground" : "text-info-foreground")}>
        {receipt.operation}
      </p>
      <p className={cn("m-0 text-[11.5px]", denied ? "text-faint" : "text-info-dim")}>{rule}</p>
      {denied ? null : <p className="m-0 text-[11.5px] text-info-dim">{recoveryNote(receipt, checkpointTaken)}</p>}
      {receipt.explanation ? (
        <p className="m-0 text-[11.5px] text-muted-foreground">{receipt.explanation}</p>
      ) : null}
      <p className="m-0 font-mono text-[10.5px] text-faint">decided from {decidedFrom}</p>
    </section>
  )
}
