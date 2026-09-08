import type { ThreadItem } from "@getdomovoi/protocol"
import { CheckIcon, CircleSlashIcon } from "lucide-react"

import { cn } from "./lib/utils"

type Receipt = Extract<ThreadItem, { kind: "receipt" }>

// What a receipt has to answer: what was decided, whether the work is
// revertible, and whether the decision outlives this moment. The design also
// shows how long the command took; no receipt or run record carries a duration,
// so this does not invent one.
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
        verdict: "Denied with an explanation",
        rule: "Nothing ran. The agent was told why, so it can propose something else.",
      }
  }
}

export function ApprovalReceipt({ receipt, className }: { receipt: Receipt, className?: string }) {
  const denied = receipt.decision === "deny" || receipt.decision === "deny-explain"
  const { verdict, rule } = decisionSummary(receipt)
  const decidedFrom = receipt.connectionId
    ? `${receipt.client}, connection ${receipt.connectionId}`
    : receipt.clientId
      ? `${receipt.client}, declared client ${receipt.clientId}`
      : receipt.client

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
      </h3>
      <p className={cn("m-0 font-mono text-[11px]", denied ? "text-muted-foreground" : "text-info-foreground")}>
        {receipt.operation}
      </p>
      <p className={cn("m-0 text-[11.5px]", denied ? "text-faint" : "text-info-dim")}>{rule}</p>
      {denied ? null : (
        <p className="m-0 text-[11.5px] text-info-dim">
          Checkpoint {receipt.checkpoint} was taken before it, so this is revertible.
        </p>
      )}
      {receipt.explanation ? (
        <p className="m-0 text-[11.5px] text-muted-foreground">{receipt.explanation}</p>
      ) : null}
      <p className="m-0 font-mono text-[10.5px] text-faint">decided from {decidedFrom}</p>
    </section>
  )
}
