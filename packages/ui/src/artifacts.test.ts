import { describe, expect, it } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { latestArtifactForActiveSession } from "./artifacts"

describe("latestArtifactForActiveSession", () => {
  it("returns the newest matching artifact for the active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = "session-billing"
    snapshot.artifacts.push({
      id: "artifact-plan-next",
      sessionId: "session-billing",
      title: "Revised migration plan",
      type: "plan",
      revision: 4,
      mimeType: "text/markdown",
      content: "## Revised plan",
    })
    snapshot.artifacts.push({
      id: "artifact-plan-other",
      sessionId: "session-onboarding",
      title: "Onboarding plan",
      type: "plan",
      revision: 9,
      content: "## Wrong session",
    })

    expect(latestArtifactForActiveSession(snapshot, "plan")?.id).toBe("artifact-plan-next")
  })

  it("returns no artifact without an active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = null

    expect(latestArtifactForActiveSession(snapshot, "plan")).toBeUndefined()
  })
})
