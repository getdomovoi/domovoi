import type { Artifact, PendingWorkingPlanEdit, WorkingPlan, WorkingPlanStep } from "@getdomovoi/protocol"
import { FileTextIcon } from "lucide-react"

import { useId, useRef, useState, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "./lib/utils"
import { MarkdownQuickView } from "./markdown-quick-view"
import { PlanStepEditor, type WorkingPlanDraftStep, type WorkingPlanEdit } from "./plan-step-editor.js"

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

export type { WorkingPlanDraftStep }

export function WorkingPlanCard({
  plan,
  running,
  onCarryOn,
  onEditPlan,
  onDiscardEdit,
  readOnly = false,
}: {
  plan: WorkingPlan | undefined
  running: boolean
  readOnly?: boolean | undefined
  onCarryOn?: (() => Promise<void>) | undefined
  onEditPlan?: ((edit: WorkingPlanEdit) => Promise<void>) | undefined
  onDiscardEdit?: ((editId: string) => Promise<void>) | undefined
}) {
  const [edit, setEdit] = useState<{ structureRevision: number, steps: { id: string, text: string }[] } | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [carryingOn, setCarryingOn] = useState(false)
  const [editError, setEditError] = useState("")
  if (!plan) return null
  const stepCount = plan.steps.length
  const baseSteps = plan.steps.map((step) => ({ id: step.id, text: step.text }))
  const editing = edit !== null
  const canEdit = Boolean(onEditPlan) && !readOnly
  const canDiscard = Boolean(onDiscardEdit) && !readOnly
  const canCarryOn = Boolean(onCarryOn) && !readOnly

  return (
    <section aria-label="Working plan" className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <h3 className="m-0 text-[12.5px] font-medium">Working plan</h3>
        <Badge variant="outline">{stepCount === 1 ? "1 step" : `${stepCount} steps`}</Badge>
        <span className="flex-1" />
        <span className="font-machine text-[9.5px] text-faint">revision {plan.revision}</span>
      </div>

      {edit && onEditPlan ? (
        <PlanStepEditor
          baseline={edit}
          onSave={(next) => onEditPlan(next).then(() => setEdit(null))}
          onCancel={() => { setEditError(""); setEdit(null) }}
        />
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
              {/* The design marks a gated step with this pill. The wire knows a
                  gate only once the step is blocked on one, so the pill names
                  the approval it stopped for, not a gate it will reach. */}
              {step.blocker ? (
                <span className="shrink-0 rounded-full border border-warn-border bg-warn-background px-2 py-0.5 font-machine text-[9.5px] text-warn-foreground">
                  STOPS FOR APPROVAL
                </span>
              ) : null}
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
            onClick={() => setEdit({ structureRevision: plan.structureRevision, steps: baseSteps })}
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
        {canCarryOn && !editing ? (
          <Button
            size="sm"
            disabled={carryingOn}
            onClick={() => {
              setEditError("")
              setCarryingOn(true)
              void onCarryOn!().then(
                () => setCarryingOn(false),
                (cause: unknown) => {
                  setCarryingOn(false)
                  setEditError(cause instanceof Error ? cause.message : "The plan reply could not be sent")
                },
              )
            }}
          >
            {carryingOn ? "Sending" : "Looks right, carry on"}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

// The anchor schema bounds a text quote at 2,000 UTF-16 units.
const maximumPlanQuoteLength = 2_000

export type PlanComment = { quote: string, body: string }

// The words a person selected inside the plan document, if any. A selection
// that starts or ends outside the document is not a quote from it.
function documentSelection(container: HTMLElement | null): string | undefined {
  if (!container) return undefined
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return undefined
  const text = selection.toString().replace(/\s+/gu, " ").trim()
  return text ? text.slice(0, maximumPlanQuoteLength) : undefined
}

function PlanCommentForm({
  quote,
  steps,
  onPost,
  onCancel,
}: {
  quote: string | undefined
  steps: readonly WorkingPlanStep[]
  onPost: (comment: PlanComment) => Promise<void>
  onCancel: () => void
}) {
  // With nothing selected, the comment anchors to a step's own words. The
  // first step not yet done is the one most likely to be in question.
  const firstOpen = steps.find((step) => step.status !== "completed") ?? steps[0]
  const [stepId, setStepId] = useState(firstOpen?.id ?? "")
  const [body, setBody] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const fieldId = useId()
  const anchor = quote ?? steps.find((step) => step.id === stepId)?.text

  const post = () => {
    const text = body.trim()
    if (!anchor || !text || pending) return
    setPending(true)
    setError("")
    void onPost({ quote: anchor.slice(0, maximumPlanQuoteLength), body: text }).then(
      () => setPending(false),
      (cause: unknown) => {
        setPending(false)
        setError(cause instanceof Error ? cause.message : "The comment could not be saved")
      },
    )
  }

  return (
    <form
      aria-label="Comment on a step"
      className="flex flex-col gap-2 rounded-lg border border-primary bg-card p-3"
      onSubmit={(event) => { event.preventDefault(); post() }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || pending) return
        event.stopPropagation()
        onCancel()
      }}
    >
      {quote ? (
        <blockquote className="m-0 border-l-2 border-primary pl-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {quote}
        </blockquote>
      ) : steps.length > 0 ? (
        <ToggleGroup
          type="single"
          orientation="vertical"
          variant="outline"
          size="sm"
          spacing={1}
          aria-label="Step"
          className="w-full flex-col items-stretch"
          value={stepId}
          onValueChange={(next) => { if (next) setStepId(next) }}
        >
          {steps.map((step, index) => (
            <ToggleGroupItem
              key={step.id}
              value={step.id}
              aria-label={step.text}
              className="h-auto justify-start gap-2 py-1.5 text-left text-[11.5px] font-normal whitespace-normal"
            >
              <span aria-hidden="true" className="font-machine text-[9.5px] text-faint">{index + 1}</span>
              <span className="min-w-0 flex-1">{step.text}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {anchor ? (
        <Field>
          <FieldLabel htmlFor={fieldId}>Comment</FieldLabel>
          <Textarea
            id={fieldId}
            value={body}
            rows={3}
            autoFocus
            disabled={pending}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
      ) : (
        <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">
          Select the words in the plan you want to comment on, then choose Comment on a step again.
        </p>
      )}
      {error ? <p role="alert" className="m-0 text-[11px] leading-relaxed text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        {anchor ? (
          <Button type="submit" size="sm" disabled={!body.trim() || pending}>{pending ? "Posting" : "Post"}</Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

// The daemon mirrors a working plan into a plan artifact of its own, id
// plan-<sessionId> with no path (isWorkingPlanArtifact in
// apps/daemon/src/working-plan.ts), so annotations have an artifact to anchor
// to. A provider's prose plan lands in the same artifact when there are no
// steps. Its text is the card's steps, so beside the card it is not a
// document; it is where a comment on a step goes when no document exists.
export function isWorkingPlanMirror(artifact: Artifact, sessionId: string): boolean {
  const mirrorId = `plan-${sessionId}`
  return artifact.sessionId === sessionId
    && artifact.type === "plan"
    && (artifact.id === mirrorId || (artifact.path === undefined && artifact.id.startsWith(`${mirrorId}-`)))
}

function latestPlanArtifact(candidates: readonly Artifact[]): Artifact | undefined {
  return candidates.reduce<Artifact | undefined>(
    (latest, artifact) => (!latest || artifact.revision >= latest.revision ? artifact : latest),
    undefined,
  )
}

// Q350 A: with a working plan, the document is the newest plan artifact the
// agent wrote (a watched file), never the mirror. Without one, the newest plan
// artifact of any kind is the document, which is how a prose plan reads. A
// comment anchors to the document, or to the mirror when only the card shows.
export function planSheetArtifacts(
  artifacts: readonly Artifact[],
  sessionId: string | null | undefined,
  workingPlan: WorkingPlan | undefined,
): { document: Artifact | undefined, commentTarget: Artifact | undefined, all: Artifact[] } {
  if (!sessionId) return { document: undefined, commentTarget: undefined, all: [] }
  const all = artifacts.filter((artifact) => artifact.sessionId === sessionId && artifact.type === "plan")
  const mirror = latestPlanArtifact(all.filter((artifact) => isWorkingPlanMirror(artifact, sessionId)))
  const document = workingPlan
    ? latestPlanArtifact(all.filter((artifact) => artifact.content && !isWorkingPlanMirror(artifact, sessionId)))
    : latestPlanArtifact(all)
  const commentTarget = document?.content ? document : workingPlan ? mirror : undefined
  return { document, commentTarget, all }
}

// The Plan tab. Q350 A: when the agent wrote a plan artifact, it is the
// document, drawn above the working-plan card rather than hidden by it, and
// Comment on a step anchors by a text quote (annotation.create, client only).
// The design's PROBLEM, APPROACH and STILL OPEN sections are fields the wire
// does not carry (Q350 B was not taken), so the document is the agent's own
// Markdown. The decision row is drawn once, under the document and the card.
export function PlanSheet({
  document,
  workingPlan,
  running,
  readOnly = false,
  comments,
  canonicalAvailable = false,
  onOpenCanonical,
  onCarryOn,
  onEditPlan,
  onDiscardEdit,
  onComment,
}: {
  document: Artifact | undefined
  workingPlan: WorkingPlan | undefined
  running: boolean
  readOnly?: boolean | undefined
  comments?: ReactNode
  canonicalAvailable?: boolean | undefined
  onOpenCanonical?: (() => void) | undefined
  onCarryOn?: (() => Promise<void>) | undefined
  onEditPlan?: ((edit: WorkingPlanEdit) => Promise<void>) | undefined
  onDiscardEdit?: ((editId: string) => Promise<void>) | undefined
  onComment?: ((comment: PlanComment) => Promise<void>) | undefined
}) {
  const documentRef = useRef<HTMLDivElement>(null)
  // A pointer press can collapse the selection before the click lands, so
  // the quote is read on press and again on click.
  const pressedQuote = useRef<string | undefined>(undefined)
  const [commenting, setCommenting] = useState<{ quote: string | undefined } | null>(null)
  const [carryingOn, setCarryingOn] = useState(false)
  const [carryOnError, setCarryOnError] = useState("")
  const content = document?.content
  const canCarryOn = Boolean(onCarryOn) && !readOnly
  const canComment = Boolean(onComment) && !readOnly

  if (!content && !workingPlan) {
    return (
      <ScrollArea className="h-full">
        <Empty className="min-h-48 border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
            <EmptyTitle>No plan content yet</EmptyTitle>
            <EmptyDescription>Plan updates from the active agent appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        {comments ? <div className="px-3 pb-3">{comments}</div> : null}
      </ScrollArea>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {/* What a selection can quote: the document and the card's steps. */}
        <div ref={documentRef}>
          {document && content ? (
            <article aria-label="Plan document" className="p-4">
              <div className="mb-4 border-b pb-3">
                <h2 className="m-0 text-[13px] font-semibold">{document.title}</h2>
                <p className="mt-1 font-machine text-mono-xs text-faint">revision {document.revision}</p>
              </div>
              <MarkdownQuickView source={content} canonicalAvailable={canonicalAvailable} {...(onOpenCanonical ? { onOpenCanonical } : {})} />
            </article>
          ) : null}
          {workingPlan ? (
            <div className={content ? "px-4 pb-4" : "p-3"}>
              <WorkingPlanCard
                plan={workingPlan}
                running={running}
                readOnly={readOnly}
                onEditPlan={onEditPlan}
                onDiscardEdit={onDiscardEdit}
              />
            </div>
          ) : null}
        </div>
        {comments ? <div className="px-4 pb-4">{comments}</div> : null}
      </ScrollArea>
      {canCarryOn || canComment ? (
        <div className="flex shrink-0 flex-col gap-2 border-t px-4 py-3">
          {commenting && onComment ? (
            <PlanCommentForm
              quote={commenting.quote}
              steps={workingPlan?.steps ?? []}
              onPost={(comment) => onComment(comment).then(() => setCommenting(null))}
              onCancel={() => setCommenting(null)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {canCarryOn ? (
              <Button
                size="sm"
                disabled={carryingOn}
                onClick={() => {
                  setCarryOnError("")
                  setCarryingOn(true)
                  void onCarryOn!().then(
                    () => setCarryingOn(false),
                    (cause: unknown) => {
                      setCarryingOn(false)
                      setCarryOnError(cause instanceof Error ? cause.message : "The plan reply could not be sent")
                    },
                  )
                }}
              >
                {carryingOn ? "Sending" : "Looks right, carry on"}
              </Button>
            ) : null}
            {canComment ? (
              <Button
                variant="outline"
                size="sm"
                disabled={commenting !== null}
                onPointerDown={() => { pressedQuote.current = documentSelection(documentRef.current) }}
                onClick={() => {
                  const quote = documentSelection(documentRef.current) ?? pressedQuote.current
                  pressedQuote.current = undefined
                  setCommenting({ quote })
                }}
              >
                Comment on a step
              </Button>
            ) : null}
          </div>
          {/* A button that returns from "Sending" in silence reads as a plan
              the agent took. The refusal belongs next to the control. */}
          {carryOnError ? (
            <p role="alert" className="m-0 text-[11px] leading-relaxed text-destructive">{carryOnError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
