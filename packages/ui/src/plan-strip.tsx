import type { WorkingPlan, WorkingPlanStep } from "@getdomovoi/protocol"
import { ChevronDownIcon } from "lucide-react"
import { useState } from "react"

import { Chip } from "./chip"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { cn } from "./lib/utils"

// v2 pins the plan above the composer instead of leaving it as a message in
// the thread. A plan keeps changing state while the conversation scrolls past
// it, so the copy you scrolled away from is stale the moment it moves.
export function currentPlanStep(plan: WorkingPlan): { step: WorkingPlanStep, index: number } | undefined {
  const running = plan.steps.findIndex((step) => step.status === "in-progress")
  if (running >= 0) return { step: plan.steps[running]!, index: running }
  const next = plan.steps.findIndex((step) => step.status !== "completed")
  if (next >= 0) return { step: plan.steps[next]!, index: next }
  const last = plan.steps.length - 1
  return last >= 0 ? { step: plan.steps[last]!, index: last } : undefined
}

function stepState(step: WorkingPlanStep): { label: string, meaning: StatusMeaning } {
  if (step.blocker) return { label: "waiting on you", meaning: "waiting" }
  if (step.status === "completed") return { label: "done", meaning: "online" }
  if (step.status === "in-progress") return { label: "running", meaning: "handoff" }
  return { label: "next", meaning: "idle" }
}

export function PlanStrip({
  plan,
  onOpenPreview,
  onDiscardEdit,
  className,
}: {
  plan: WorkingPlan | undefined
  onOpenPreview?: () => void
  onDiscardEdit?: (editId: string) => void
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  if (!plan || plan.steps.length === 0) return null
  const current = currentPlanStep(plan)
  if (!current) return null
  const state = stepState(current.step)

  return (
    <section aria-label="Working plan" className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      {plan.pendingEdit ? (
        <div className="flex items-center gap-2 border-b border-info-border bg-info-background px-3 py-2">
          <span className="text-[12px] text-info-foreground">
            {plan.pendingEdit.status === "queued"
              ? "Your edit is queued. It applies at the next turn boundary, not to the turn in flight."
              : "Your edit did not apply, because the plan changed underneath it."}
          </span>
          {onDiscardEdit ? (
            <button
              type="button"
              className="ml-auto text-[11px] text-info-dim"
              onClick={() => onDiscardEdit(plan.pendingEdit!.id)}
            >
              Discard
            </button>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <ol className="m-0 flex list-none flex-col p-0">
          {plan.steps.map((step, index) => (
            <li key={step.id} className="flex items-start gap-3 border-b border-border px-3 py-2">
              <span className="w-4 shrink-0 font-mono text-[10.5px] text-faint">
                {step.status === "completed" ? "✓" : index + 1}
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] text-foreground">{step.text}</span>
              <StatusDot {...stepState(step)} size="inline" />
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-[10.5px] text-strong">
          Step {current.index + 1} of {plan.steps.length}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{current.step.text}</span>
        <Chip size="badge" tone={state.meaning === "waiting" ? "warning" : "neutral"}>
          {state.label}
        </Chip>
        {onOpenPreview ? (
          <button type="button" className="text-[11px] text-primary" onClick={onOpenPreview}>
            Plan preview
          </button>
        ) : null}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse the plan" : "Expand the plan"}
          onClick={() => setExpanded((open) => !open)}
          className="text-muted-foreground"
        >
          <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      </div>
    </section>
  )
}
