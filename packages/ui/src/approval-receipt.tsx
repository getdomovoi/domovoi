import type { ThreadItem } from "@getdomovoi/protocol"

import { Button } from "./components/ui/button"
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
        // J34, ruled 2026-09-23: only a person's allow takes a checkpoint, so
        // a run the rule lets through later takes none.
        rule: "Later requests matching it run without asking. Later runs under the rule do not take a checkpoint. Retire the rule in Rules.",
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

// The dock tabs a receipt's link opens: the rule an Always saved, or the
// checkpoints for any other decision.
export type ReceiptDockTab = "checkpoints" | "rules"

// What the design offers after the latest decision. Each opens a surface the
// thread already has, and each is drawn only when its caller can open it.
export type ReceiptActions = {
  onReviewChanges?: (() => void) | undefined
  onMoveSession?: (() => void) | undefined
  onOpenDockTab?: ((tab: ReceiptDockTab) => void) | undefined
}

export function ApprovalReceipt({
  receipt,
  checkpointTaken = false,
  className,
  actions,
}: {
  receipt: Receipt
  // Set when the thread shows the checkpoint this allow took; see
  // receiptCheckpointTaken.
  checkpointTaken?: boolean
  className?: string
  // Set on the latest receipt only, as drawn.
  actions?: ReceiptActions | undefined
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

  // The design tones an allow ok and a denial danger, each with its dot.
  const tone = denied ? toneClasses.danger : toneClasses.ok
  const link = receipt.decision === "always-project"
    ? { tab: "rules" as const, label: "See the rule" }
    : { tab: "checkpoints" as const, label: "See the checkpoints" }
  const { onReviewChanges, onMoveSession, onOpenDockTab } = actions ?? {}

  return (
    <>
      <section
        aria-label="Decision receipt"
        className={cn("mx-auto flex w-full max-w-3xl flex-col gap-1.5 rounded-xl border px-3.5 py-[11px]", tone.frame, className)}
      >
        <h3 className={cn("m-0 flex items-center gap-2.5 text-[12.5px] font-medium", tone.text)}>
          <span aria-hidden data-receipt-dot={denied ? "danger" : "ok"} className={cn("size-[7px] shrink-0 rounded-full", tone.dot)} />
          {verdict}
          {meta ? <span className={cn("ml-auto font-machine text-[10.5px] font-normal", tone.dim)}>{meta}</span> : null}
        </h3>
        <p className={cn("m-0 font-machine text-[11px]", tone.text)}>{receipt.operation}</p>
        {/* One body, as drawn: what happened to the files, then whether the
            decision outlives the moment. */}
        <p className={cn("m-0 text-[13px] leading-[1.6] text-pretty", tone.text)}>
          {denied ? null : <><span>{recoveryNote(receipt, checkpointTaken)}</span>{" "}</>}
          <span>{rule}</span>
        </p>
        {receipt.explanation ? (
          <p className={cn("m-0 text-[12px]", tone.text)}>{receipt.explanation}</p>
        ) : null}
        <p className={cn("m-0 font-machine text-[10.5px]", tone.dim)}>decided from {decidedFrom}</p>
      </section>
      {onReviewChanges || onMoveSession || onOpenDockTab ? (
        // The design's follow-up row: review, move, and the link to what the
        // decision wrote. The count of changed files is the sample's; the
        // changes sheet says how many.
        <div role="group" aria-label="After this decision" className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2">
          {onReviewChanges ? (
            <Button size="sm" className="h-8 px-[15px] text-[13px] font-semibold" onClick={onReviewChanges}>Review the changed files</Button>
          ) : null}
          {onMoveSession ? (
            <Button variant="outline" size="sm" className="h-8 px-[15px] text-[12px] font-normal text-muted-foreground" onClick={onMoveSession}>Move this session to another machine</Button>
          ) : null}
          {onOpenDockTab ? (
            <Button variant="link" size="xs" className="ml-auto text-[11.5px] font-normal" onClick={() => onOpenDockTab(link.tab)}>
              {link.label}<span aria-hidden> →</span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

const toneClasses = {
  ok: { frame: "border-ok-border bg-ok-background", text: "text-ok-foreground", dim: "text-ok-dim", dot: "bg-success" },
  danger: { frame: "border-danger-border bg-danger-background", text: "text-danger-foreground", dim: "text-danger-dim", dot: "bg-destructive" },
} as const
