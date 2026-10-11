import { describe, expect, it } from "vitest"

import { demoWorkspace, type Artifact, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { renderedPreviewsForActiveSession } from "./preview-renders"

const sessionId = demoWorkspace.activeSessionId!

function preview(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId,
    title: `${id}.html`,
    type: "preview",
    revision: 1,
    mimeType: "text/html",
    path: `.domovoi/previews/${id}.html`,
    ...overrides,
  }
}

function snapshotWith(artifacts: Artifact[]): WorkspaceSnapshot {
  return { ...demoWorkspace, artifacts }
}

describe("renderedPreviewsForActiveSession", () => {
  it("lists every render of the active session in the order the daemon first saw them", () => {
    const rows = renderedPreviewsForActiveSession(snapshotWith([
      preview("runbook", { revision: 3 }),
      preview("other-session", { sessionId: "someone-else" }),
      preview("panel"),
    ]))

    expect(rows.map((row) => row.artifactId)).toEqual(["runbook", "panel"])
    expect(rows[0]).toMatchObject({ label: "runbook.html", meta: ".domovoi/previews · revision 3" })
  })

  it("draws one row per variant group, named for the group and opened on its first variant", () => {
    // The watcher's group id is the variants' directory and each title is a
    // file name, so a variant's title would name one variant, not the group.
    const rows = renderedPreviewsForActiveSession(snapshotWith([
      preview("replay-b", { title: "variant-b.html", path: "design-studio/replay/variant-b.html", variant: { groupId: "design-studio/replay", id: "b", label: "Variant B", order: 2 } }),
      preview("runbook"),
      preview("replay-a", { title: "variant-a.html", path: "design-studio/replay/variant-a.html", variant: { groupId: "design-studio/replay", id: "a", label: "Variant A", order: 1 } }),
    ]))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      artifactId: "replay-a",
      artifactIds: ["replay-a", "replay-b"],
      label: "replay",
      meta: "design-studio · 2 variants",
    })
    expect(rows[1]?.artifactId).toBe("runbook")
  })

  it("names a group whose id is not a path by the id itself", () => {
    const rows = renderedPreviewsForActiveSession(snapshotWith([
      preview("only", { path: "only.html", variant: { groupId: "hero options", id: "a", label: "Variant A", order: 0 } }),
    ]))

    expect(rows[0]).toMatchObject({ label: "hero options", meta: "1 variant" })
  })

  it("leaves out what the preview frame cannot open", () => {
    const rows = renderedPreviewsForActiveSession(snapshotWith([
      { id: "no-path", sessionId, title: "no-path.html", type: "preview", revision: 1, mimeType: "text/html" },
      preview("markdown", { mimeType: "text/markdown" }),
      { ...preview("plan"), type: "plan" },
      preview("page", { path: "page.html" }),
    ]))

    expect(rows.map((row) => row.artifactId)).toEqual(["page"])
    expect(rows[0]?.meta).toBe("revision 1")
  })

  it("lists nothing without an active session", () => {
    expect(renderedPreviewsForActiveSession({ ...snapshotWith([preview("page")]), activeSessionId: null })).toEqual([])
  })
})
