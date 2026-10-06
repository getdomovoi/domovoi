import type { ApprovalRequest, WorkingPlan } from "./schema.js"

// Read the current plan so edits and removed blockers cannot leave a stale
// step number on a persisted approval. Handheld snapshots carry plans too.
export function approvalPlanStep(
  plans: readonly WorkingPlan[],
  approval: Pick<ApprovalRequest, "id" | "sessionId">,
): { step: number; of: number } | undefined {
  const plan = plans.find((candidate) => candidate.sessionId === approval.sessionId)
  if (plan === undefined) return undefined
  const index = plan.steps.findIndex((step) => step.blocker?.approvalId === approval.id)
  return index === -1 ? undefined : { step: index + 1, of: plan.steps.length }
}
