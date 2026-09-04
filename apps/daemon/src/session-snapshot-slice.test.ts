import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  workspaceSnapshotSchema,
} from "@getdomovoi/protocol"

import {
  mergeSessionSnapshotSlice,
  sessionSnapshotTransferPolicy,
} from "./session-snapshot-slice.js"

describe("session snapshot slice", () => {
  it("classifies every workspace key as session-owned or deliberately preserved", () => {
    const everyOptionalKey = workspaceSnapshotSchema.parse({
      ...structuredClone(demoWorkspace),
      historyTruncated: true,
    })

    expect(Object.keys(sessionSnapshotTransferPolicy).sort()).toEqual(
      Object.keys(everyOptionalKey).sort(),
    )
    expect(sessionSnapshotTransferPolicy).toEqual({
      protocolVersion: "preserve",
      machine: "preserve",
      project: "preserve",
      sessions: "session-slice",
      activeSessionId: "preserve",
      approvals: "session-slice",
      approvalRules: "preserve",
      thread: "session-slice",
      artifacts: "session-slice",
      workingPlans: "session-slice",
      annotations: "session-slice",
      skillEnablements: "preserve",
      historyTruncated: "preserve",
    })
  })

  it("applies only one session slice to the latest workspace", () => {
    const sessionId = "session-billing"
    const otherSessionId = "session-onboarding"
    const latest = structuredClone(demoWorkspace)
    latest.activeSessionId = sessionId
    latest.thread.push({
      id: "other-session-concurrent-item",
      sessionId: otherSessionId,
      kind: "system",
      body: "Concurrent work survives.",
      createdAt: "2026-09-04T00:00:00.000Z",
    })

    const candidate = structuredClone(demoWorkspace)
    candidate.activeSessionId = otherSessionId
    const transferred = candidate.sessions.find((session) => session.id === sessionId)!
    transferred.title = "Transferred title"
    candidate.thread = candidate.thread.filter((item) => item.sessionId !== sessionId)
    candidate.thread.push({
      id: "transfer-receipt",
      sessionId,
      kind: "system",
      body: "Transfer receipt.",
      createdAt: "2026-09-04T00:00:01.000Z",
    })
    candidate.approvals = candidate.approvals.filter(
      (approval) => approval.sessionId !== sessionId,
    )

    const merged = mergeSessionSnapshotSlice(latest, candidate, sessionId)

    expect(merged.sessions.find((session) => session.id === sessionId)?.title)
      .toBe("Transferred title")
    expect(merged.sessions.find((session) => session.id === otherSessionId))
      .toEqual(latest.sessions.find((session) => session.id === otherSessionId))
    expect(merged.thread).toContainEqual(expect.objectContaining({ id: "transfer-receipt" }))
    expect(merged.thread).toContainEqual(expect.objectContaining({
      id: "other-session-concurrent-item",
    }))
    expect(merged.approvalRules).toBe(latest.approvalRules)
    expect(merged.skillEnablements).toBe(latest.skillEnablements)
    expect(merged.activeSessionId).toBe(sessionId)
  })
})
