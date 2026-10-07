import type { PolicyRefusalThreadItem } from "@getdomovoi/protocol"
import { useId } from "react"

import { cn } from "./lib/utils"

export type PolicyRefusal = Pick<
  PolicyRefusalThreadItem,
  "operation" | "command" | "rule" | "setBy" | "scope" | "remedy"
>

// The Desktop v2 refusal: a danger card with the command, why, and the rule
// it broke, then a plain card with what to do instead. The design's step n of
// N meta, the target the agent saw and tone-coded alternatives need fields
// the wire does not carry; the one remedy the daemon sends is the list.
export function PolicyRefusalCard({ refusal, className }: { refusal: PolicyRefusal; className?: string }) {
  const insteadId = useId()
  const chain = [
    ["Set by", refusal.setBy],
    ["Applies to", refusal.scope],
  ] as const

  return (
    <div className={cn("mx-auto flex w-full max-w-3xl flex-col gap-3", className)}>
      <section
        aria-label="Policy refusal"
        className="flex flex-col overflow-hidden rounded-xl border border-danger-border bg-danger-background"
      >
        <h3 className="m-0 flex items-center gap-2.5 px-3.5 py-3 text-[12.5px] font-medium text-danger-foreground">
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-destructive" />
          Refused by policy, there is nothing to approve
        </h3>
        <div className="px-3.5 pb-3">
          <code className="block rounded-md bg-code px-[13px] py-[11px] font-machine text-[11.5px] break-all whitespace-pre-wrap text-danger-foreground">
            {refusal.command}
          </code>
        </div>
        <div className="flex flex-col gap-1.5 px-3.5 pb-[13px] text-[13px] leading-[1.6] text-pretty text-danger-foreground">
          <p className="m-0">{refusal.operation}</p>
          <p className="m-0">
            Approving this would not run it. The daemon refuses the command before it starts, so there is no
            override, including from an owner.
          </p>
        </div>
        <div className="px-3.5 pb-3.5">
          <div role="group" aria-label="The rule it broke" className="rounded-lg border border-danger-border px-3.5 py-3">
            <p aria-hidden className="m-0 text-[10.5px] tracking-[.13em] text-danger-dim">THE RULE IT BROKE</p>
            <p className="m-0 mt-[5px] text-[14px] leading-[1.45] font-medium text-danger-foreground">{refusal.rule}</p>
            <dl className="m-0 mt-[9px]">
              {chain.map(([label, value], index) => (
                <div
                  key={label}
                  className={cn("flex items-baseline gap-3 py-2", index > 0 && "border-t border-danger-border/55")}
                >
                  <dt className="shrink-0 text-[11.5px] text-danger-dim">{label}</dt>
                  <dd className="m-0 ml-auto min-w-0 text-right text-[12px] break-words text-danger-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>
      <section aria-labelledby={insteadId} className="overflow-hidden rounded-xl border bg-card">
        <h4 id={insteadId} className="m-0 border-b px-3.5 py-[11px] text-[13px] font-semibold">What you can do instead</h4>
        <ul className="m-0 list-none p-0">
          <li className="flex items-start gap-2.5 px-3.5 py-2.5 text-[12px] leading-[1.55] text-strong">
            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
            {refusal.remedy}
          </li>
        </ul>
      </section>
    </div>
  )
}
