import type { PendingWorkingPlanEdit, WorkingPlan, WorkingPlanStep } from "@getdomovoi/protocol"

import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { cn } from "./lib/utils"

function stepMark(step: WorkingPlanStep, index: number): string {
  return step.status === "completed" ? "✓" : String(index + 1)
}

function stepStateLabel(step: WorkingPlanStep): string | undefined {
  if (step.blocker) return "waiting"
  if (step.status === "completed") return "done"
  if (step.status === "in-progress") return "running"
  return undefined
}

function pendingEditCopy(edit: PendingWorkingPlanEdit): string {
  return edit.status === "queued"
    ? `Your edit applies at the next turn boundary. Submitted from ${edit.submittedBy.client}.`
    : `Your edit did not apply because the plan changed underneath it. Submitted from ${edit.submittedBy.client}.`
}

export function WorkingPlanCard({
  plan,
  running,
}: {
  plan: WorkingPlan | undefined
  running: boolean
}) {
  if (!plan) return null
  const stepCount = plan.steps.length

  return (
    <section aria-label="Working plan" className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <h3 className="m-0 text-[12.5px] font-medium">Working plan</h3>
        <Badge variant="outline">{stepCount === 1 ? "1 step" : `${stepCount} steps`}</Badge>
        <span className="flex-1" />
        <span className="font-machine text-[9.5px] text-faint">revision {plan.revision}</span>
      </div>

      <ul aria-label="Plan steps" className="m-0 flex list-none flex-col p-0">
        {plan.steps.map((step, index) => {
          const state = stepStateLabel(step)
          return (
            <li key={step.id} className="flex items-center gap-2.5 px-3 py-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-[17px] shrink-0 items-center justify-center rounded-full font-machine text-[9.5px]",
                  step.status === "completed"
                    ? "bg-success/15 text-success"
                    : step.blocker
                      ? "bg-warning/15 text-warning"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {stepMark(step, index)}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 text-[11.5px] leading-relaxed",
                  step.status === "pending" ? "text-faint" : "text-foreground",
                )}
              >
                {step.text}
              </span>
              {state ? (
                <span
                  className={cn(
                    "shrink-0 font-machine text-[9.5px]",
                    step.blocker ? "text-warning" : "text-faint",
                  )}
                >
                  {state}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>

      {plan.pendingEdit ? (
        <>
          <Separator />
          <div
            role="status"
            aria-label="Pending plan edit"
            className="flex flex-col gap-1.5 px-3.5 py-2.5"
          >
            <span className={cn(
              "text-[11px] leading-relaxed",
              plan.pendingEdit.status === "conflicted" ? "text-warning" : "text-muted-foreground",
            )}>
              {pendingEditCopy(plan.pendingEdit)}
            </span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {plan.pendingEdit.draftSteps.map((step) => (
                <li key={step.id} className="font-machine text-[10px] text-muted-foreground">
                  {step.text}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <Separator />
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className="flex-1" />
        {running ? (
          <span className="font-machine text-[9.5px] text-faint">pinned while running</span>
        ) : null}
      </div>
    </section>
  )
}
