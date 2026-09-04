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
  }
}
