import { describe, expect, it } from "vitest"

import { demoWorkspace, maximumRenderedPreviewStages, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { latestArtifactForActiveSession, maximumPreviewVariants, previewControlLayoutFor, previewStageGridColumns, previewStageObservationKey, previewStagesForReview, previewToolbarLayoutFor, previewVariantsForActiveSession, previewVariantWindowForActiveSession, reviewLayoutFor, sessionPreviewBuildBasis } from "./artifacts"

// The basis a send may carry is the one the daemon accepts: a preview artifact
// of that same session. Anything else would refuse the whole message.
describe("sessionPreviewBuildBasis", () => {
  const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
  snapshot.artifacts.push({
    id: "onboarding-preview", sessionId: "session-onboarding", title: "Onboarding", type: "preview", revision: 1,
  })
  it("names a preview of the session", () => {
    expect(sessionPreviewBuildBasis(snapshot, "session-billing", "artifact-preview")?.id).toBe("artifact-preview")
  })
  it("drops an id that is gone, of another session, not a preview, or absent", () => {
    expect(sessionPreviewBuildBasis(snapshot, "session-billing", "gone")).toBeUndefined()
    expect(sessionPreviewBuildBasis(snapshot, "session-billing", "onboarding-preview")).toBeUndefined()
    expect(sessionPreviewBuildBasis(snapshot, "session-billing", "artifact-plan")).toBeUndefined()
    expect(sessionPreviewBuildBasis(snapshot, "session-billing", undefined)).toBeUndefined()
  })
})

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
    // The window is a page of 24 by order: variant-0 (order 29) sits on the
    // second page, orders 24 to 29.
    const selectedWindow = previewVariantsForActiveSession(snapshot, "variant-0")
    expect(selectedWindow).toHaveLength(6)
    expect(selectedWindow[0]?.variant?.order).toBe(24)
    expect(selectedWindow.at(-1)?.id).toBe("variant-0")
    const firstPage = previewVariantsForActiveSession(snapshot, "variant-29")
    expect(firstPage).toHaveLength(24)
    expect(firstPage[0]?.id).toBe("variant-29")
  })

  // #810 B5.3: a group over 24 variants opened at its first variant showed
  // orders 0 to 23 and nothing reached the rest. Pages reach every variant.
  it("pages a group over the variant budget so every variant is reachable", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = "session-billing"
    snapshot.artifacts = Array.from({ length: 60 }, (_, index) => ({
      id: `variant-${index}`, sessionId: "session-billing", title: `Variant ${index}`,
      type: "preview" as const, revision: 1, path: `design-studio/x/variant-${index}.html`, mimeType: "text/html",
      variant: { id: `${index}`, groupId: "design-studio/x", label: `Variant ${index}`, order: index },
    }))
    const reached = new Set<string>()
    let window = previewVariantWindowForActiveSession(snapshot, "variant-0")
    expect(window).toMatchObject({ start: 0, total: 60 })
    expect(window.previousPageArtifactId).toBeUndefined()
    for (;;) {
      expect(window.variants.length).toBeLessThanOrEqual(maximumPreviewVariants)
      for (const variant of window.variants) reached.add(variant.id)
      if (!window.nextPageArtifactId) break
      window = previewVariantWindowForActiveSession(snapshot, window.nextPageArtifactId)
    }
    expect(reached.size).toBe(60)
    expect(window).toMatchObject({ start: 48, total: 60 })
    expect(window.variants.map((variant) => variant.id)).toContain("variant-59")
    expect(window.previousPageArtifactId).toBe("variant-24")
    expect(previewVariantWindowForActiveSession(snapshot, "variant-24").variants[0]?.id).toBe("variant-24")
  })

  it("keeps a group within the budget on one page", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = "session-billing"
    snapshot.artifacts = Array.from({ length: 3 }, (_, index) => ({
      id: `variant-${index}`, sessionId: "session-billing", title: `Variant ${index}`,
      type: "preview" as const, revision: 1, path: `design-studio/x/variant-${index}.html`, mimeType: "text/html",
      variant: { id: `${index}`, groupId: "design-studio/x", label: `Variant ${index}`, order: index },
    }))
    const window = previewVariantWindowForActiveSession(snapshot, "variant-2")
    expect(window).toMatchObject({ start: 0, total: 3 })
    expect(window.previousPageArtifactId).toBeUndefined()
    expect(window.nextPageArtifactId).toBeUndefined()
  })

  it("falls back from compare when the container is narrow", () => {
    expect(reviewLayoutFor(700, true, 2)).toEqual({ compare: false, stages: 1 })
    expect(reviewLayoutFor(900, true, 3)).toEqual({
      compare: true,
      stages: maximumRenderedPreviewStages,
    })
    expect(reviewLayoutFor(900, true, 1)).toEqual({ compare: false, stages: 1 })
  })

  it("selects every requested review stage and derives matching columns", () => {
    const variants = Array.from({ length: 3 }, (_, index) => ({
      id: `variant-${index}`,
      sessionId: "session-billing",
      title: `Variant ${index}`,
      type: "preview" as const,
      revision: 1,
      path: `variant-${index}.html`,
      mimeType: "text/html",
    }))

    expect(previewStagesForReview(variants, variants[1], 3).map(({ id }) => id)).toEqual([
      "variant-1",
      "variant-0",
      "variant-2",
    ])
    expect(previewStageGridColumns(3)).toBe("repeat(3, minmax(0, 1fr))")
    expect(previewStagesForReview(variants, variants[1], 1)).toEqual([variants[1]])
    expect(previewStageGridColumns(1)).toBe("repeat(1, minmax(0, 1fr))")
  })

  it("wraps review controls in narrow containers", () => {
    expect(previewToolbarLayoutFor(520)).toBe("wrap")
    expect(previewControlLayoutFor(520)).toEqual({ wrap: true, fullWidth: true })
    expect(previewToolbarLayoutFor(900)).toBe("inline")
    expect(previewControlLayoutFor(900)).toEqual({ wrap: false, fullWidth: false })
  })

  it("restarts stage observation after same-preview error recovery", () => {
    expect(previewStageObservationKey("artifact-a", "authorization failed")).not.toBe(
      previewStageObservationKey("artifact-a", ""),
    )
  })
})
