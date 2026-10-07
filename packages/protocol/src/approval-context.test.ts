import { describe, expect, it } from "vitest"

import * as protocol from "./index.js"

const approval = protocol.demoWorkspace.approvals[0]!
const origin = { client: "desktop", connectionId: "11111111-1111-4111-8111-111111111111", clientId: "desktop-owner" }

describe("approval context", () => {
  it("parses older persisted approvals without inventing facts", () => {
    const parsed = protocol.approvalRequestSchema.parse(approval)
    expect(parsed).not.toHaveProperty("origin")
    expect(parsed).not.toHaveProperty("outsideProject")
  })

  it.each(["path", "working-directory"])("round trips attribution and the %s containment basis", (basis) => {
    const card = { ...approval, origin, outsideProject: { outside: false, basis } }
    expect(protocol.approvalRequestSchema.parse(card)).toEqual(card)
    expect(protocol.approvalRequestSchema.parse({ ...card, origin: { client: "phone", connectionId: origin.connectionId } }).origin)
      .not.toHaveProperty("clientId")
  })

  it.each([
    { origin: { ...origin, client: "unknown" } },
    { origin: { ...origin, connectionId: "invalid" } },
    { origin: { ...origin, clientId: "x".repeat(129) } },
    { origin: { ...origin, you: true } },
    { outsideProject: false },
    { outsideProject: { outside: false } },
    { outsideProject: { outside: "false", basis: "path" } },
    { outsideProject: { outside: false, basis: "command" } },
    { outsideProject: { outside: false, basis: "path", path: "/private/file" } },
  ])("rejects malformed facts: %j", (facts) => {
    expect(protocol.approvalRequestSchema.safeParse({ ...approval, ...facts }).success).toBe(false)
  })
})

describe("approvalPlanStep", () => {
  const plan: protocol.WorkingPlan = {
    sessionId: approval.sessionId, revision: 1, structureRevision: 1,
    createdAt: approval.requestedAt, updatedAt: approval.requestedAt,
    steps: [
      { id: "first", text: "Inspect", status: "completed" },
      { id: "second", text: "Change", status: "in-progress", blocker: { kind: "approval", approvalId: approval.id } },
      { id: "third", text: "Verify", status: "pending" },
    ],
  }

  it("derives the current 1-based position from the named blocker", () => {
    expect(protocol.approvalPlanStep([plan], approval)).toEqual({ step: 2, of: 3 })
    expect(protocol.approvalPlanStep([{ ...plan, steps: plan.steps.slice(1) }], approval)).toEqual({ step: 1, of: 2 })
  })

  it("does not infer a step from activity, another session, or a missing plan", () => {
    expect(protocol.approvalPlanStep([], approval)).toBeUndefined()
    expect(protocol.approvalPlanStep([plan], { ...approval, id: "unrelated" })).toBeUndefined()
    expect(protocol.approvalPlanStep([plan], { ...approval, sessionId: "other" })).toBeUndefined()
    expect(protocol.approvalPlanStep([{ ...plan, steps: [{ id: "active", text: "Active", status: "in-progress" }] }], approval)).toBeUndefined()
  })
})
