import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type WorkingPlanDraftStep = { id?: string, text: string }

export type WorkingPlanEdit = {
  basedOnStructureRevision: number
  baseSteps: { id: string, text: string }[]
  draftSteps: WorkingPlanDraftStep[]
}

// One editor for the plan's steps, used by the Plan preview card and by the
// strip above the composer. It holds the baseline it opened against so the
// daemon can refuse an edit the plan has moved out from under.
export function PlanStepEditor({
  baseline,
  onSave,
  onCancel,
}: {
  baseline: { structureRevision: number, steps: { id: string, text: string }[] }
  onSave: (edit: WorkingPlanEdit) => Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<WorkingPlanDraftStep[]>(baseline.steps)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const save = () => {
    setError("")
    setSaving(true)
    void onSave({
      basedOnStructureRevision: baseline.structureRevision,
      baseSteps: baseline.steps,
      draftSteps: draft.map((step) => step.id === undefined ? { text: step.text } : { id: step.id, text: step.text }),
    }).then(
      () => setSaving(false),
      (cause: unknown) => {
        setSaving(false)
        setError(cause instanceof Error ? cause.message : "The plan edit was refused")
      },
    )
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {draft.map((step, index) => (
        <div key={step.id ?? `new-${index}`} className="flex items-center gap-1.5">
          <Input
            aria-label={`Step ${index + 1}`}
            value={step.text}
            onChange={(event) => setDraft(draft.map((candidate, position) => (
              position === index ? { ...candidate, text: event.target.value } : candidate
            )))}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move step ${index + 1} up`}
            disabled={index === 0}
            onClick={() => setDraft(draft.map((candidate, position) => (
              position === index - 1 ? draft[index]! : position === index ? draft[index - 1]! : candidate
            )))}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove step ${index + 1}`}
            onClick={() => setDraft(draft.filter((_, position) => position !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="m-0 text-[11px] leading-relaxed text-destructive">
          {error} Your steps are still here.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={saving} onClick={() => setDraft([...draft, { text: "" }])}>Add step</Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button variant="secondary" size="sm" disabled={saving} onClick={save}>Save plan</Button>
      </div>
    </div>
  )
}
