import { describe, expect, it } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { WorkspaceNotificationTracker } from "./desktop-notifications"

function snapshot(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("WorkspaceNotificationTracker", () => {
  it("treats the first verified snapshot as hydration", () => {
    const current = snapshot()
    current.sessions[0]!.state = "done"
    current.approvals.push({ ...current.approvals[0]!, id: "approval-secret", command: "TOKEN=secret" })

    expect(new WorkspaceNotificationTracker().observe(current)).toEqual([])
  })

  it("reports completion, failure, and newly requested approval transitions", () => {
    const tracker = new WorkspaceNotificationTracker()
    const before = snapshot()
    before.sessions[0]!.state = "active"
    before.sessions[1]!.state = "active"
    before.approvals = []
    tracker.observe(before)

    const after = structuredClone(before)
    after.sessions[0]!.state = "done"
    after.sessions[0]!.updatedAt = "2026-08-30T18:01:00.000Z"
    after.sessions[1]!.state = "failed"
    after.sessions[1]!.updatedAt = "2026-08-30T18:02:00.000Z"
    after.approvals = [{ ...demoWorkspace.approvals[0]!, id: "approval-new", sessionId: after.sessions[0]!.id }]

    expect(tracker.observe(after)).toEqual([
      expect.objectContaining({ kind: "completion", sessionId: after.sessions[0]!.id }),
      expect.objectContaining({ kind: "failure", sessionId: after.sessions[1]!.id }),
      expect.objectContaining({ kind: "approval-needed", sessionId: after.sessions[0]!.id }),
    ])
  })

  it("deduplicates replayed snapshots and repeated transition identifiers", () => {
    const tracker = new WorkspaceNotificationTracker()
    const before = snapshot()
    before.sessions[0]!.state = "active"
    tracker.observe(before)

    const done = structuredClone(before)
    done.sessions[0]!.state = "done"
    done.sessions[0]!.updatedAt = "2026-08-30T18:03:00.000Z"
    expect(tracker.observe(done)).toHaveLength(1)
    expect(tracker.observe(structuredClone(done))).toEqual([])

    tracker.observe(before)
    expect(tracker.observe(done)).toEqual([])
  })

  it("emits bounded opaque identifiers without notification copy or approval details", () => {
    const tracker = new WorkspaceNotificationTracker()
    const before = snapshot()
    before.approvals = []
    tracker.observe(before)

    const after = structuredClone(before)
    after.approvals = [{
      ...demoWorkspace.approvals[0]!,
      id: "approval-with-secret",
      command: "curl https://secret.invalid?token=do-not-leak",
      directory: "/private/project",
      sessionId: before.sessions[0]!.id,
    }]
    const [request] = tracker.observe(after)
    const serialized = JSON.stringify(request)

    expect(request?.id).toMatch(/^desktop-approval-needed-[a-f0-9]{16}$/)
    expect(serialized).not.toContain("do-not-leak")
    expect(serialized).not.toContain("/private/project")
    expect(Object.keys(request ?? {}).sort()).toEqual(["id", "kind", "sessionId"])
  })
})
