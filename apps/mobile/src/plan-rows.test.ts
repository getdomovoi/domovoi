import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { planForSession, planStepEdit, planStrip, planSummary, revisedLabel } from "./plan-rows"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

function billingPlan(snapshot: WorkspaceSnapshot) {
  const plan = planForSession(snapshot, "session-billing")
  if (!plan) throw new Error("fixture needs a working plan")
  return plan
}

describe("planForSession", () => {
  it("finds only the plan belonging to the session being read", () => {
    expect(planForSession(workspace(), "session-audit")).toBeUndefined()
    expect(planForSession(workspace(), "session-billing")?.sessionId).toBe("session-billing")
  })
})

describe("planSummary", () => {
  it("counts completed steps, which is what the header says", () => {
    expect(planSummary(billingPlan(workspace())).progress).toBe("2 of 4")
  })

  it("ticks finished steps and numbers the rest by their place in the plan", () => {
    const rows = planSummary(billingPlan(workspace())).rows

    expect(rows.map((row) => row.mark)).toEqual(["✓", "✓", "3", "4"])
    expect(rows.map((row) => row.tone)).toEqual(["done", "done", "running", "queued"])
  })

  it("says a step is waiting on a person when something blocks it", () => {
    const snapshot = workspace()
    const plan = billingPlan(snapshot)
    const step = plan.steps[3]
    if (!step) throw new Error("fixture needs a fourth step")
    step.blocker = { kind: "approval", approvalId: "approval-migrate" }

    const row = planSummary(plan).rows[3]

    expect(row?.tone).toBe("blocked")
    expect(row?.meta).toBe("waiting on you")
  })

  it("reports an edit nobody has accepted, rather than showing stale steps silently", () => {
    expect(planSummary(billingPlan(workspace())).pendingEdit).toBe("conflicted")
  })
})

describe("revisedLabel", () => {
  it("says when the plan last changed as a wall-clock time", () => {
    expect(revisedLabel(new Date(2026, 8, 16, 14, 6).toISOString())).toBe("revised 14:06")
    expect(revisedLabel(new Date(2026, 8, 16, 9, 3).toISOString())).toBe("revised 09:03")
  })

  it("says nothing for a timestamp it cannot read", () => {
    expect(revisedLabel("not a date")).toBeUndefined()
  })
})

describe("planStepEdit", () => {
  it("rewrites one step against the plan's current structure and names the edit it replaces", () => {
    const plan = billingPlan(workspace())

    const edit = planStepEdit(plan, "plan-step-tests", "Cover expiry and duplicate delivery in replay.spec.ts")

    expect(edit.basedOnStructureRevision).toBe(plan.structureRevision)
    expect(edit.baseSteps).toEqual(plan.steps.map((step) => ({ id: step.id, text: step.text })))
    expect(edit.draftSteps.map((step) => step.id)).toEqual(plan.steps.map((step) => step.id))
    expect(edit.draftSteps[3]?.text).toBe("Cover expiry and duplicate delivery in replay.spec.ts")
    expect(edit.draftSteps[0]?.text).toBe(plan.steps[0]?.text)
    expect(edit.replacesPendingEditId).toBe("plan-edit-migration-order")
  })

  it("replaces nothing when no edit is pending", () => {
    const plan = billingPlan(workspace())
    delete plan.pendingEdit

    expect(planStepEdit(plan, "plan-step-tests", "x").replacesPendingEditId).toBeUndefined()
  })

  it("refuses a step the plan does not hold", () => {
    expect(() => planStepEdit(billingPlan(workspace()), "plan-step-missing", "x")).toThrow(/not in this plan/)
  })
})

describe("planSummary header", () => {
  it("carries when the plan was revised", () => {
    const plan = billingPlan(workspace())
    plan.updatedAt = new Date(2026, 8, 16, 14, 6).toISOString()

    expect(planSummary(plan).revised).toBe("revised 14:06")
  })
})

describe("planStrip", () => {
  it("names the step in progress and its place in the plan", () => {
    expect(planStrip(planSummary(billingPlan(workspace())))).toBe("Step 3 of 4 · Apply the migration on this machine's dev database")
  })

  it("names the step waiting on a person when one is", () => {
    const plan = billingPlan(workspace())
    const step = plan.steps[3]
    if (!step) throw new Error("fixture needs four steps")
    step.blocker = { kind: "approval", approvalId: "approval-migrate" }

    expect(planStrip(planSummary(plan))).toBe("Step 4 of 4 · waiting on you · Rewrite replay.spec.ts to assert exactly-once delivery")
  })

  it("counts what is done when nothing is running", () => {
    const plan = billingPlan(workspace())
    for (const step of plan.steps) step.status = step.status === "in-progress" ? "pending" : step.status

    expect(planStrip(planSummary(plan))).toBe("2 of 4 done")
  })
})
