import { CircleSlashIcon } from "lucide-react"

import { cn } from "./lib/utils"

// A refusal is not a gate. The daemon refuses before the command runs, so no
// client-side decision can permit it and this card carries no approve control.
// It is deliberately not the amber gate card: amber means a person is being
// waited on, and nobody is waiting here.
//
// There is no wire shape for this yet. approvalRiskSchema is normal | hard-gate
// and every approval carries decisions, so the fields below are named by the
// design rather than read from the protocol. When a shape lands, this type is
// what it has to satisfy.
export type PolicyRefusal = {
  operation: string
  command: string
  rule: string
  setBy: string
  scope: string
  remedy: string
}

export function PolicyRefusalCard({ refusal, className }: { refusal: PolicyRefusal; className?: string }) {
  // A chain of custody reads in order: what was asked, which rule refused it,
  // who set that rule, and how far it reaches. A two-column fact grid would
  // scramble that into lookup order.
  const custody = [
    ["Rule", refusal.rule],
    ["Set by", refusal.setBy],
    ["Scope", refusal.scope],
  ] as const

  return (
    <section
      aria-label="Policy refusal"
      className={cn(
        "mx-auto flex max-w-3xl flex-col gap-3 rounded-xl border border-danger-border bg-danger-background p-4",
        className,
      )}
    >
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-danger-foreground">
        <CircleSlashIcon aria-hidden className="size-4" />
        Refused by policy
      </h3>
      <p className="text-[13px] text-danger-foreground">{refusal.operation}</p>
      <code className="rounded-md bg-code px-3 py-2 font-mono text-[11px] break-all whitespace-pre-wrap text-danger-foreground">
        {refusal.command}
      </code>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {custody.map(([label, value], index) => (
          <li key={label} className="flex items-baseline gap-3 text-[11.5px]">
            <span className="w-14 shrink-0 text-danger-dim">{label}</span>
            <span className="min-w-0 font-mono text-danger-foreground">{value}</span>
            {index < custody.length - 1 ? <span aria-hidden className="text-danger-dim">↓</span> : null}
          </li>
        ))}
      </ol>
      <p className="text-[12.5px] text-danger-foreground">
        Approving this would not run it. The daemon refuses the command before it starts, so there is no
        override, including from an owner.
      </p>
      <p className="text-[12.5px] text-danger-dim">{refusal.remedy}</p>
    </section>
  )
}
