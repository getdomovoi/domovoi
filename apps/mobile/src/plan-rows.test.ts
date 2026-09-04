import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { planForSession, planSummary } from "./plan-rows"

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
