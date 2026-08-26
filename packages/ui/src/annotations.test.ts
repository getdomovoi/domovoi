import { describe, expect, it } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { annotationsForActiveSession } from "./annotations"

describe("annotationsForActiveSession", () => {
  it("returns only annotations owned by the active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.annotations.push({
      ...structuredClone(snapshot.annotations[0]!),
      id: "annotation-onboarding",
      sessionId: "session-onboarding",
    })

    expect(annotationsForActiveSession(snapshot).map((annotation) => annotation.id)).toEqual([
      "annotation-migration-machine",
      "annotation-replay-copy",
    ])
  })

  it("returns no annotations without an active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = null

    expect(annotationsForActiveSession(snapshot)).toEqual([])
  })
})
