import type { PendingWorkingPlanEdit, WorkingPlan, WorkingPlanStep } from "@getdomovoi/protocol"
import { ChevronDownIcon } from "lucide-react"
import { useState } from "react"

import { Chip } from "./chip"
import { PlanStepEditor, type WorkingPlanEdit } from "./plan-step-editor.js"
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

// The queued notice names the step the edit touches, the way the design's
// copy does ("Your edit to step 4 is queued"). The first step whose text or
// position differs between the base and the draft is that step; an edit that
// only adds or removes steps, or changes several, is named as a whole.
export function queuedEditStep(edit: PendingWorkingPlanEdit): number | undefined {
  const changed = edit.draftSteps.flatMap((step, index) => {
    const base = edit.baseSteps[index]
    return base && base.id === step.id && base.text === step.text ? [] : [index]
  })
  if (edit.baseSteps.length !== edit.draftSteps.length) return undefined
  return changed.length === 1 ? changed[0]! + 1 : undefined
}

export function queuedEditCopy(edit: PendingWorkingPlanEdit): string {
  if (edit.status !== "queued") return "Your edit did not apply, because the plan changed underneath it."
  const step = queuedEditStep(edit)
  return `${step === undefined ? "Your edit" : `Your edit to step ${step}`} is queued. It applies at the next turn boundary, not to the turn in flight.`
}

export function PlanStrip({
  plan,
  onOpenPreview,
  onEditPlan,
  onDiscardEdit,
  readOnly = false,
  className,
}: {
  plan: WorkingPlan | undefined
  onOpenPreview?: () => void
  onEditPlan?: ((edit: WorkingPlanEdit) => Promise<void>) | undefined
  onDiscardEdit?: (editId: string) => void
  // A viewer of an archived or borrowed session sees the plan and cannot
  // change it; the design draws Edit dimmed for that viewer, not absent.
  readOnly?: boolean
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [edit, setEdit] = useState<{ structureRevision: number, steps: { id: string, text: string }[] } | null>(null)
  if (!plan || plan.steps.length === 0) return null
  const current = currentPlanStep(plan)
  if (!current) return null
  const state = stepState(current.step)
  const startEdit = () => {
    setEdit({ structureRevision: plan.structureRevision, steps: plan.steps.map((step) => ({ id: step.id, text: step.text })) })
    setExpanded(true)
  }

  return (
    <section aria-label="Working plan" className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      {plan.pendingEdit ? (
        <div className="flex items-center gap-2 border-b border-info-border bg-info-background px-3 py-2">
          <span className="text-[12px] text-info-foreground">
            {queuedEditCopy(plan.pendingEdit)}
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

      {edit && onEditPlan ? (
        <PlanStepEditor
          baseline={edit}
          onSave={(next) => onEditPlan(next).then(() => setEdit(null))}
          onCancel={() => setEdit(null)}
        />
      ) : expanded ? (
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
        <StatusDot meaning={state.meaning} label={state.label} size="inline" labelHidden />
        <span className="font-mono text-[10.5px] text-strong">
          Step {current.index + 1} of {plan.steps.length}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{current.step.text}</span>
        <Chip size="badge" tone={state.meaning === "waiting" ? "warning" : "neutral"}>
          {state.label}
        </Chip>
        {onEditPlan ? (
          <button
            type="button"
            aria-label="Edit the plan"
            className="text-[11px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45"
            disabled={readOnly || edit !== null}
            {...(readOnly ? { title: "This session is read-only here, so its plan cannot be edited from this view." } : {})}
            onClick={startEdit}
          >
            Edit
          </button>
        ) : null}
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
