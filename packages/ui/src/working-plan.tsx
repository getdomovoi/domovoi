import type { PendingWorkingPlanEdit, WorkingPlan, WorkingPlanStep } from "@getdomovoi/protocol"

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

export type WorkingPlanDraftStep = { id?: string, text: string }

export function WorkingPlanCard({
  plan,
  running,
  onEditPlan,
  onDiscardEdit,
  readOnly = false,
}: {
  plan: WorkingPlan | undefined
  running: boolean
  readOnly?: boolean | undefined
  onEditPlan?: ((edit: {
    basedOnStructureRevision: number
    baseSteps: { id: string, text: string }[]
    draftSteps: WorkingPlanDraftStep[]
  }) => Promise<void>) | undefined
  onDiscardEdit?: ((editId: string) => Promise<void>) | undefined
}) {
  const [edit, setEdit] = useState<{
    baseline: { structureRevision: number, steps: { id: string, text: string }[] }
    draft: WorkingPlanDraftStep[]
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [editError, setEditError] = useState("")
  if (!plan) return null
  const stepCount = plan.steps.length
  const baseSteps = plan.steps.map((step) => ({ id: step.id, text: step.text }))
  const draft = edit?.draft ?? null
  const editing = edit !== null
  const canEdit = Boolean(onEditPlan) && !readOnly
  const canDiscard = Boolean(onDiscardEdit) && !readOnly
  const setDraft = (next: WorkingPlanDraftStep[] | null) => {
    setEdit((current) => next === null || !current ? null : { ...current, draft: next })
  }
  const save = () => {
    if (!edit || !onEditPlan) return
    setEditError("")
    setSaving(true)
    void onEditPlan({
      basedOnStructureRevision: edit.baseline.structureRevision,
      baseSteps: edit.baseline.steps,
      draftSteps: edit.draft.map((step) => step.id === undefined ? { text: step.text } : { id: step.id, text: step.text }),
    }).then(
      () => {
        setSaving(false)
        setEdit(null)
      },
      (cause: unknown) => {
        setSaving(false)
        setEditError(cause instanceof Error ? cause.message : "The plan edit was refused")
      },
    )
  }

  return (
    <section aria-label="Working plan" className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <h3 className="m-0 text-[12.5px] font-medium">Working plan</h3>
        <Badge variant="outline">{stepCount === 1 ? "1 step" : `${stepCount} steps`}</Badge>
        <span className="flex-1" />
        <span className="font-machine text-[9.5px] text-faint">revision {plan.revision}</span>
      </div>

      {edit ? (
        <div className="flex flex-col gap-2 px-3 py-3">
          {edit.draft.map((step, index) => (
            <div key={step.id ?? `new-${index}`} className="flex items-center gap-1.5">
              <Input
                aria-label={`Step ${index + 1}`}
                value={step.text}
                onChange={(event) => setDraft(edit.draft.map((candidate, position) => (
                  position === index ? { ...candidate, text: event.target.value } : candidate
                )))}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move step ${index + 1} up`}
                disabled={index === 0}
                onClick={() => setDraft(edit.draft.map((candidate, position) => (
                  position === index - 1 ? edit.draft[index]! : position === index ? edit.draft[index - 1]! : candidate
                )))}
              >
                ↑
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove step ${index + 1}`}
                onClick={() => setDraft(edit.draft.filter((_, position) => position !== index))}
              >
                ×
              </Button>
            </div>
          ))}
          {editError ? (
            <p role="alert" className="m-0 text-[11px] leading-relaxed text-destructive">
              {editError} Your steps are still here.
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setDraft([...edit.draft, { text: "" }])}>Add step</Button>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setEditError(""); setEdit(null) }}>Cancel</Button>
            <Button variant="secondary" size="sm" disabled={saving} onClick={save}>Save plan</Button>
          </div>
        </div>
      ) : stepCount === 0 ? (
        <p className="m-0 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
          No steps yet. The agent adds them as it plans, and you can write the first one yourself.
        </p>
      ) : (
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
      )}

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

      {editError && !edit ? (
        <>
          <Separator />
          <p role="alert" className="m-0 px-3.5 py-2.5 text-[11px] leading-relaxed text-destructive">
            {editError}
          </p>
        </>
      ) : null}

      <Separator />
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        {canEdit && !editing ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEdit({
              baseline: { structureRevision: plan.structureRevision, steps: baseSteps },
              draft: baseSteps,
            })}
          >
            Edit plan
          </Button>
        ) : null}
        {canDiscard && plan.pendingEdit ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={discarding}
            onClick={() => {
              const editId = plan.pendingEdit!.id
              setEditError("")
              setDiscarding(true)
              void onDiscardEdit!(editId).then(
                () => setDiscarding(false),
                (cause: unknown) => {
                  setDiscarding(false)
                  setEditError(cause instanceof Error ? cause.message : "The edit could not be discarded")
                },
              )
            }}
          >
            Discard edit
          </Button>
        ) : null}
        <span className="flex-1" />
        {running ? (
          <span className="font-machine text-[9.5px] text-faint">pinned while running</span>
        ) : null}
      </div>
    </section>
  )
}
