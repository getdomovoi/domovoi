import type { WorkingPlan, WorkspaceSnapshot } from "@getdomovoi/protocol"

export type PlanRow = {
  id: string
  // A finished step earns a tick; an unfinished one keeps its number, because
  // "step 3" is how the agent and the person refer to it.
  mark: string
  text: string
  meta: string
  tone: "done" | "blocked" | "running" | "queued"
}

export type PlanSummary = {
  progress: string
  rows: PlanRow[]
  // A queued edit is a change to the plan that nobody has accepted yet, and a
  // conflicted one is a change that no longer applies. Both are things the
  // phone should say rather than quietly render the old steps.
  pendingEdit: "queued" | "conflicted" | undefined
  // When the plan last changed, as a time of day. The plan is a document, and
  // a document says when it was last revised.
  revised: string | undefined
}

// The wire shape of one step rewritten in place, minus the session and the
// client, which the caller adds. It is built against the plan's current
// structure so the daemon can refuse it if the plan moved underneath.
export type PlanStepEdit = {
  basedOnStructureRevision: number
  baseSteps: { id: string, text: string }[]
  draftSteps: { id: string, text: string }[]
  replacesPendingEditId: string | undefined
}

export function revisedLabel(iso: string): string | undefined {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const pad = (value: number) => String(value).padStart(2, "0")
  return `revised ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function planStepEdit(plan: WorkingPlan, stepId: string, text: string): PlanStepEdit {
  if (!plan.steps.some((step) => step.id === stepId)) {
    throw new Error(`Step ${stepId} is not in this plan`)
  }
  const baseSteps = plan.steps.map((step) => ({ id: step.id, text: step.text }))
  return {
    basedOnStructureRevision: plan.structureRevision,
    baseSteps,
    draftSteps: baseSteps.map((step) => step.id === stepId ? { id: step.id, text } : step),
    replacesPendingEditId: plan.pendingEdit?.id,
  }
}

function toneFor(row: WorkingPlan["steps"][number]): PlanRow["tone"] {
  if (row.status === "completed") return "done"
  if (row.blocker) return "blocked"
  return row.status === "in-progress" ? "running" : "queued"
}

const metas: Record<PlanRow["tone"], string> = {
  done: "done",
  blocked: "waiting on you",
  running: "in progress",
  queued: "queued",
}

export function planForSession(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
): WorkingPlan | undefined {
  return snapshot.workingPlans.find((plan) => plan.sessionId === sessionId)
}

export function planSummary(plan: WorkingPlan): PlanSummary {
  const completed = plan.steps.filter((step) => step.status === "completed").length
  return {
    progress: `${completed} of ${plan.steps.length}`,
    rows: plan.steps.map((step, index) => {
      const tone = toneFor(step)
      return {
        id: step.id,
        mark: tone === "done" ? "✓" : String(index + 1),
        text: step.text,
        meta: metas[tone],
        tone,
      }
    }),
    pendingEdit: plan.pendingEdit?.status,
    revised: revisedLabel(plan.updatedAt),
  }
}

// One line for the strip that sits above the thread while the plan is
// pinned: the step the machine is on, or the one a person is holding up,
// or how far along the plan is when nothing is running. Tapping the strip
// lifts the whole plan; the strip only has to say why you would.
export function planStrip(plan: PlanSummary): string {
  const total = plan.rows.length
  const blocked = plan.rows.findIndex((row) => row.tone === "blocked")
  if (blocked >= 0) return `Step ${blocked + 1} of ${total} · waiting on you · ${plan.rows[blocked]!.text}`
  const running = plan.rows.findIndex((row) => row.tone === "running")
  if (running >= 0) return `Step ${running + 1} of ${total} · ${plan.rows[running]!.text}`
  return `${plan.progress} done`
}

// Pinned is the default, so the app remembers only the sessions whose plan
// a person unpinned. Unpinning one plan says nothing about another: a person
// coming back to session B finds B as they left B.
export function unpinnedAfter(unpinned: ReadonlySet<string>, sessionId: string, pinned: boolean): ReadonlySet<string> {
  const next = new Set(unpinned)
  if (pinned) next.delete(sessionId)
  else next.add(sessionId)
  return next
}
