import { describe, expect, it } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { latestArtifactForActiveSession, previewControlLayoutFor, previewToolbarLayoutFor, previewVariantsForActiveSession, reviewLayoutFor } from "./artifacts"

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

  it("keeps generated HTML canonical when a Markdown plan also exists", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = "session-billing"
    snapshot.artifacts.push({ id: "plan-md", sessionId: "session-billing", title: "Plan", type: "plan", revision: 99, mimeType: "text/markdown", content: "# Plan" })
    snapshot.artifacts.push({ id: "plan-html", sessionId: "session-billing", title: "Plan preview", type: "preview", revision: 100, mimeType: "text/html", path: "plan-preview.html" })
    expect(latestArtifactForActiveSession(snapshot, "preview")?.id).toBe("plan-html")
  })
})

describe("previewVariantsForActiveSession", () => {
  it("groups, orders, and bounds only explicit variants", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = "session-billing"
    snapshot.artifacts = Array.from({ length: 30 }, (_, index) => ({
      id: `variant-${index}`, sessionId: "session-billing", title: `Variant ${index}`,
      type: "preview" as const, revision: 1, path: `design-studio/x/variant-${index}.html`, mimeType: "text/html",
      variant: { id: `${index}`, groupId: "design-studio/x", label: `Variant ${index}`, order: 29 - index },
    }))
    const selectedWindow = previewVariantsForActiveSession(snapshot, "variant-0")
    expect(selectedWindow).toHaveLength(24)
    expect(selectedWindow[0]?.variant?.order).toBe(6)
    expect(selectedWindow.at(-1)?.id).toBe("variant-0")
  })

  it("falls back from compare when the container is narrow", () => {
    expect(reviewLayoutFor(700, true, 2)).toEqual({ compare: false, stages: 1 })
    expect(reviewLayoutFor(900, true, 2)).toEqual({ compare: true, stages: 2 })
  })

  it("wraps review controls in narrow containers", () => {
    expect(previewToolbarLayoutFor(520)).toBe("wrap")
    expect(previewControlLayoutFor(520)).toEqual({ wrap: true, fullWidth: true })
    expect(previewToolbarLayoutFor(900)).toBe("inline")
    expect(previewControlLayoutFor(900)).toEqual({ wrap: false, fullWidth: false })
  })
})
