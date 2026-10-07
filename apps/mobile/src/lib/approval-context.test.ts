import { approvalRequestSchema, demoWorkspace, type ApprovalRequest, type WorkingPlan } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { approvalContextFacts, approvalOriginLine, approvalOutsideProjectLine, approvalStepLine } from "./approval-context"

// Every card here goes through the wire's own schema, so a fact the protocol
// would refuse cannot pass for one the phone draws.
function card(facts: Partial<Pick<ApprovalRequest, "origin" | "outsideProject">> = {}): ApprovalRequest {
  const approval = structuredClone(demoWorkspace).approvals[0]
  if (!approval) throw new Error("fixture needs a pending approval")
  return approvalRequestSchema.parse({ ...approval, ...facts })
}

const connectionId = "11111111-1111-4111-8111-111111111111"
const thisPhone = { client: "phone", deviceId: "device-0123456789abcdef0123456789abcdef" } as const

function plan(approvalId: string, sessionId: string): WorkingPlan {
  return {
    sessionId, revision: 1, structureRevision: 1,
    createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z",
    steps: [
      { id: "first", text: "Inspect", status: "completed" },
      { id: "second", text: "Change", status: "in-progress", blocker: { kind: "approval", approvalId } },
      { id: "third", text: "Verify", status: "pending" },
    ],
  }
}

describe("approvalOriginLine", () => {
  it("says you when the turn came from this paired phone", () => {
    const approval = card({ origin: { client: "phone", connectionId, clientId: thisPhone.deviceId } })
    expect(approvalOriginLine(approval.origin, thisPhone)).toBe("you, on this phone")
  })

  it("names another client by its kind", () => {
    expect(approvalOriginLine(card({ origin: { client: "desktop", connectionId, clientId: "desktop-owner" } }).origin, thisPhone)).toBe("a desktop")
    expect(approvalOriginLine(card({ origin: { client: "web", connectionId } }).origin, thisPhone)).toBe("a browser")
    expect(approvalOriginLine(card({ origin: { client: "tablet", connectionId, clientId: "device-feed" } }).origin, thisPhone)).toBe("a tablet")
    expect(approvalOriginLine(card({ origin: { client: "cli", connectionId } }).origin, thisPhone)).toBe("the command line")
  })

  it("says another phone only when this phone knows its own id", () => {
    const other = card({ origin: { client: "phone", connectionId, clientId: "device-ffffffffffffffffffffffffffffffff" } }).origin
    expect(approvalOriginLine(other, thisPhone)).toBe("another phone")
    // A phone on a bearer token, or one whose id has not arrived yet, cannot
    // tell itself from another phone, so it says only what it knows.
    expect(approvalOriginLine(other, { client: "phone" })).toBe("a phone")
    expect(approvalOriginLine(card({ origin: { client: "phone", connectionId, clientId: thisPhone.deviceId } }).origin, { client: "phone" })).toBe("a phone")
    // Without its own id the phone can still rule out another kind of client.
    expect(approvalOriginLine(card({ origin: { client: "desktop", connectionId } }).origin, { client: "phone" })).toBe("a desktop")
  })

  it("draws nothing when the daemon did not attribute the turn", () => {
    expect(approvalOriginLine(card().origin, thisPhone)).toBeUndefined()
  })
})

describe("approvalOutsideProjectLine", () => {
  it("states the containment and the basis it was judged on", () => {
    expect(approvalOutsideProjectLine(card({ outsideProject: { outside: true, basis: "path" } }).outsideProject))
      .toEqual({ value: "yes, by the path it names", outside: true })
    expect(approvalOutsideProjectLine(card({ outsideProject: { outside: false, basis: "path" } }).outsideProject))
      .toEqual({ value: "no, by the path it names", outside: false })
    expect(approvalOutsideProjectLine(card({ outsideProject: { outside: true, basis: "working-directory" } }).outsideProject))
      .toEqual({ value: "yes, by where it runs", outside: true })
  })

  // A working directory inside the project does not hold a command inside it.
  it("does not let a working directory inside the project read as a contained command", () => {
    expect(approvalOutsideProjectLine(card({ outsideProject: { outside: false, basis: "working-directory" } }).outsideProject))
      .toEqual({ value: "no, by where it runs, not by what it reaches", outside: false })
  })

  it("draws nothing for an unknown fact", () => {
    expect(approvalOutsideProjectLine(card().outsideProject)).toBeUndefined()
  })
})

describe("approvalStepLine", () => {
  it("gives the step whose blocker names this approval", () => {
    const approval = card()
    expect(approvalStepLine([plan(approval.id, approval.sessionId)], approval)).toBe("step 2 of 3")
  })

  it("draws nothing when no step names the approval", () => {
    const approval = card()
    expect(approvalStepLine([], approval)).toBeUndefined()
    expect(approvalStepLine(undefined, approval)).toBeUndefined()
    expect(approvalStepLine([plan("approval-other", approval.sessionId)], approval)).toBeUndefined()
    expect(approvalStepLine([plan(approval.id, "session-other")], approval)).toBeUndefined()
  })
})

describe("approvalContextFacts", () => {
  it("returns only the facts the wire carries, each under its own label", () => {
    const approval = card({
      origin: { client: "desktop", connectionId },
      outsideProject: { outside: true, basis: "path" },
    })
    expect(approvalContextFacts(approval, { plans: [plan(approval.id, approval.sessionId)], viewer: thisPhone })).toEqual({
      origin: { key: "Turn from", value: "a desktop" },
      step: { key: "Plan", value: "step 2 of 3" },
      outsideProject: { key: "Outside project", value: "yes, by the path it names", tone: "text-warning" },
    })
    expect(approvalContextFacts(card(), { plans: [], viewer: thisPhone })).toEqual({})
  })
})
