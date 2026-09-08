import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { groupSessions, sessionsNeedingYou } from "./session-groups"

function snapshotWith(sessions: WorkspaceSnapshot["sessions"], approvalSessionId?: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.sessions = sessions
  snapshot.approvals = approvalSessionId
    ? [{ ...structuredClone(demoWorkspace).approvals[0]!, sessionId: approvalSessionId }]
    : []
  return snapshot
}

function session(overrides: Partial<WorkspaceSnapshot["sessions"][number]>): WorkspaceSnapshot["sessions"][number] {
  return { ...structuredClone(demoWorkspace).sessions[0]!, ...overrides }
}

describe("grouping sessions for the drawer", () => {
  it("calls a gated session Running while its turn is still in flight", () => {
    const groups = groupSessions(snapshotWith([session({ id: "s1", activeTurnId: "turn-1" })], "s1"))
    expect(groups[0]!.id).toBe("running")
    expect(groups[0]!.sessions[0]!.note).toBe("waiting on you")
  })

  it("moves a gated session to Needs you once nothing is running", () => {
    const groups = groupSessions(snapshotWith([session({ id: "s1", state: "waiting" })], "s1"))
    expect(groups[0]!.id).toBe("needs-you")
  })

  it("puts a failed session where a person will see it", () => {
    const groups = groupSessions(snapshotWith([session({ id: "s1", state: "failed" })]))
    expect(groups[0]!.id).toBe("needs-you")
    expect(groups[0]!.sessions[0]!.note).toBe("failed")
  })

  it("treats an ownership conflict as needing a person, not as quiet", () => {
    const groups = groupSessions(snapshotWith([session({ id: "s1", state: "ownership-conflict" })]))
    expect(groups[0]!.id).toBe("needs-you")
  })

  it("says a transferred session moved rather than calling it idle", () => {
    const groups = groupSessions(snapshotWith([session({ id: "s1", state: "transferred" })]))
    expect(groups[0]!.id).toBe("quiet")
    expect(groups[0]!.sessions[0]!.note).toBe("moved to another machine")
  })

  it("leaves archived sessions out entirely", () => {
    expect(groupSessions(snapshotWith([session({ id: "s1", state: "archived" })]))).toEqual([])
  })

  it("shows no empty group", () => {
    const groups = groupSessions(snapshotWith([session({ id: "s1", state: "idle" })]))
    expect(groups.map((group) => group.id)).toEqual(["quiet"])
  })

  it("counts what is waiting on a person", () => {
    const snapshot = snapshotWith([
      session({ id: "s1", state: "failed" }),
      session({ id: "s2", state: "waiting" }),
      session({ id: "s3", activeTurnId: "turn-1" }),
    ], "s2")
    expect(sessionsNeedingYou(snapshot)).toBe(2)
  })
})
