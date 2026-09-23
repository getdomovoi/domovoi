import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { groupSessions } from "./session-groups"

function needingYou(snapshot: WorkspaceSnapshot): number {
  return groupSessions(snapshot).find((group) => group.id === "needs-you")?.sessions.length ?? 0
}

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
  // Membership follows the row's own state: a session whose note says it is
  // waiting on you cannot sit under Running, or the label and the row disagree.
  it("puts a gated session under Needs you even while its turn is still in flight", () => {
    const groups = groupSessions(snapshotWith([session({ id: "s1", activeTurnId: "turn-1" })], "s1"))
    expect(groups[0]!.id).toBe("needs-you")
    expect(groups[0]!.sessions[0]!.note).toBe("waiting on you")
    expect(groups[0]!.sessions[0]!.running).toBe(true)
    expect(groups.map((group) => group.id)).toEqual(["needs-you"])
  })

  it("leads with Needs you, then Running, then Quiet", () => {
    const groups = groupSessions(snapshotWith([
      session({ id: "s1", activeTurnId: "turn-1" }),
      session({ id: "s2", state: "idle" }),
      session({ id: "s3", state: "failed" }),
    ]))
    expect(groups.map((group) => group.id)).toEqual(["needs-you", "running", "quiet"])
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
    expect(needingYou(snapshot)).toBe(2)
  })

  it("counts a gated session that is still running as waiting on a person", () => {
    expect(needingYou(snapshotWith([session({ id: "s1", activeTurnId: "turn-1" })], "s1"))).toBe(1)
  })
})
