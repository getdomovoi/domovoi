import { useId, type ComponentType } from "react"
import {
  KeyRoundIcon,
  PuzzleIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  WebhookIcon,
} from "lucide-react"

import type { RepositoryTrustState } from "@getdomovoi/protocol"

import { cn } from "./lib/utils"
import { trustRefusalLabel, type ToolRowKind } from "./tool-inventory-model"

// Pieces the Tools tab and the trust review sheet both draw.

export const kindIcon: Record<ToolRowKind, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  "tool-server": ServerIcon,
  hook: WebhookIcon,
  "permission-rule": ShieldCheckIcon,
  "env-key": KeyRoundIcon,
  helper: TerminalIcon,
  plugin: PuzzleIcon,
  skill: SparklesIcon,
}

export const eyebrow = "text-[10.5px] font-medium tracking-[0.13em] text-faint"
export const mono = "font-machine"

export function TrustRefusals({ trust, name }: { trust: RepositoryTrustState; name: string }) {
  const titleId = useId()
  if (trust.state !== "untrusted" || trust.reason !== "cannot-trust") return null
  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2.5 px-[15px] pt-3 pb-1">
        <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
        <h2 id={titleId} className="m-0 text-[13px] font-medium">{name} cannot be trusted on this machine</h2>
      </div>
      <p className="m-0 px-[15px] pb-3 text-[12px] text-muted-foreground">Its agents would also load what is listed here, and trust cannot cover it.</p>
      <ul className="m-0 list-none p-0">
        {trust.refusals.map((refusal, index) => (
          <li key={`${refusal.provider}:${refusal.code}:${refusal.path}:${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-[15px] py-[9px]">
            <span className={cn(mono, "w-24 shrink-0 text-[11px] text-strong")}>{refusal.provider}</span>
            <span className="min-w-0 flex-1 basis-64 text-[11.5px] text-muted-foreground">{trustRefusalLabel[refusal.code]}</span>
            <span className={cn(mono, "text-[10.5px] break-all text-faint")}>{refusal.path}</span>
          </li>
        ))}
      </ul>
      {trust.omittedRefusals > 0 ? (
        <p className="m-0 border-t px-[15px] py-[9px] text-[11.5px] text-muted-foreground">{trust.omittedRefusals} more {trust.omittedRefusals === 1 ? "reason is" : "reasons are"} not listed.</p>
      ) : null}
    </section>
  )
}

// Where the person reviews, and trust is granted: never from a phone or
// tablet (ruling Q67).
export function GrantedWhere() {
  return <span className="text-[11.5px] text-faint">Granted from desktop or web only.</span>
}

export function omittedText(count: number): string {
  return `${count} more ${count === 1 ? "entry was" : "entries were"} left out to keep the answer within its size limit. They are not listed here.`
}
