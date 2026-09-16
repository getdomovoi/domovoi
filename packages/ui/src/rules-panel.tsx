import type { ApprovalRule, HardGateCategory } from "@getdomovoi/protocol"
import { useEffect, useState } from "react"

import { ScrollArea } from "./components/ui/scroll-area"
import { cn } from "./lib/utils"

// v2's Rules tab: what you have already allowed, scoped to a repository and a
// machine, how often each rule answered for you, a one-click Revoke, and the
// things a rule can never cover. Rules are the snapshot's approvalRules for the
// open project; the never-covered list is what the daemon's own policy reports
// through permission.hardGates, so this pane never carries a copy of it.
export const rulesIntro = "What you have already allowed. Scoped to a repository and a machine."

type ActiveRule = Extract<ApprovalRule, { status: "active" }>

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
function createdStamp(iso: string): string {
  const created = new Date(iso)
  if (Number.isNaN(created.getTime())) return iso
  return `${created.getUTCDate()} ${months[created.getUTCMonth()]} ${created.getUTCFullYear()}`
}

// "acme-api on mac-mini-m4 · created 3 Sep 2026 at a gate from desktop". A
// rule only ever comes from answering a gate with Always, so "at a gate" is a
// fact about how rules are made, not a guess about this one.
export function ruleScopeLabel(rule: ApprovalRule, projectName: string, machineName: string): string {
  return `${projectName} on ${machineName} · created ${createdStamp(rule.createdAt)} at a gate from ${rule.createdBy}`
}

export function ruleUsedLabel(useCount: number): string {
  return useCount === 0 ? "never used" : `used ${useCount}×`
}

type Gates =
  | { status: "loading" }
  | { status: "ready", categories: HardGateCategory[] }
  | { status: "failed", message: string }

export function RulesPanel({
  rules,
  projectName,
  machineName,
  readOnly = false,
  onRevoke,
  onLoadHardGates,
}: {
  rules: readonly ApprovalRule[]
  projectName: string
  machineName: string
  readOnly?: boolean | undefined
  onRevoke: (ruleId: string) => Promise<void>
  onLoadHardGates: () => Promise<HardGateCategory[]>
}) {
  const [gates, setGates] = useState<Gates>({ status: "loading" })
  const [pending, setPending] = useState<string>()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const active = rules.filter((rule): rule is ActiveRule => rule.status === "active")
  const retired = rules.length - active.length

  useEffect(() => {
    let live = true
    onLoadHardGates().then(
      (categories) => { if (live) setGates({ status: "ready", categories }) },
      (cause: unknown) => { if (live) setGates({ status: "failed", message: cause instanceof Error ? cause.message : "Hard gates could not be read" }) },
    )
    return () => { live = false }
  }, [onLoadHardGates])

  const revoke = (ruleId: string) => {
    setPending(ruleId)
    setErrors((current) => ({ ...current, [ruleId]: "" }))
    onRevoke(ruleId).then(
      () => setPending(undefined),
      (cause: unknown) => {
        setPending(undefined)
        setErrors((current) => ({ ...current, [ruleId]: cause instanceof Error ? cause.message : "The rule could not be revoked" }))
      },
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-3">
        <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">{rulesIntro}</p>
        {active.length === 0 ? (
          <p className="m-0 rounded-xl border bg-card px-3 py-4 text-[12px] leading-relaxed text-muted-foreground">
            No standing rules for this project. Answering a gate with Always adds one here.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            {active.map((rule, index) => (
              <div key={rule.id} data-testid="rule-row" className={cn("flex flex-col gap-1.5 px-3 py-2.5", index > 0 && "border-t")}>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-machine text-[11.5px] text-strong">{rule.command}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{ruleScopeLabel(rule, projectName, machineName)}</div>
                  </div>
                  <span className="shrink-0 font-machine text-mono-xs text-faint">{ruleUsedLabel(rule.useCount)}</span>
                  <button
                    type="button"
                    disabled={readOnly || pending === rule.id}
                    {...(readOnly ? { title: "This session is read-only here, so its rules cannot be changed from this view." } : {})}
                    onClick={() => revoke(rule.id)}
                    className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-danger-border hover:bg-danger-background hover:text-danger-foreground disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {pending === rule.id ? "Revoking" : "Revoke"}
                  </button>
                </div>
                {errors[rule.id] ? (
                  <p role="alert" className="m-0 text-[11px] leading-relaxed text-destructive">
                    {errors[rule.id]} The rule still stands.
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {retired > 0 ? (
          <p className="m-0 text-[11px] text-faint">
            {retired === 1 ? "1 retired rule is kept in Settings" : `${retired} retired rules are kept in Settings`}, with who granted it and why it no longer answers.
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <span className="text-eyebrow tracking-[.13em] text-faint">NEVER COVERED BY A RULE</span>
          {gates.status === "loading" ? (
            <p role="status" className="m-0 font-machine text-mono-xs text-faint">Reading the daemon's hard gates</p>
          ) : gates.status === "failed" ? (
            <p role="alert" className="m-0 text-[11px] leading-relaxed text-destructive">
              The hard-gate list could not be read: {gates.message}. Hard gates still apply; only this list is missing.
            </p>
          ) : (
            <ul aria-label="Never covered by a rule" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {gates.categories.map((category) => (
                <li key={category.id} className="rounded-full border border-dashed border-warn-border bg-warn-background px-2.5 py-1 text-[11px] text-warn-foreground">
                  {category.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}
