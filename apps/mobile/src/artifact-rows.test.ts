import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  artifactBody,
  artifactRows,
  diffLines,
  findArtifact,
  maximumRenderedArtifactLines,
  previewVariants,
} from "./artifact-rows"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("artifactRows", () => {
  it("keeps only the session being read", () => {
    const snapshot = workspace()
    const artifact = snapshot.artifacts[0]
    if (!artifact) throw new Error("fixture needs an artifact")
    snapshot.artifacts = [
      ...snapshot.artifacts,
      { ...artifact, id: "artifact-elsewhere", sessionId: "session-audit" },
    ]

    const rows = artifactRows(snapshot, "session-billing")

    expect(rows.some((row) => row.id === "artifact-elsewhere")).toBe(false)
  })

  it("calls an artifact readable only when the daemon sent its contents", () => {
    const snapshot = workspace()
    const plan = snapshot.artifacts.find((artifact) => artifact.type === "plan")
    if (!plan) throw new Error("fixture needs a plan artifact")
    plan.content = "# Plan"
    plan.mimeType = "text/markdown"

    const rows = artifactRows(snapshot, "session-billing")

    expect(rows.find((row) => row.id === plan.id)?.readable).toBe(true)
    expect(rows.find((row) => row.type === "preview")?.readable).toBe(false)
  })

  it("says a preview is fetched with a grant, rather than showing an empty frame", () => {
    const preview = artifactRows(workspace(), "session-billing")
      .find((row) => row.type === "preview")

    expect(preview?.detail).toContain("signed grant")
  })

  it("keeps variants of one preview together and in the order the daemon gave them", () => {
    const snapshot = workspace()
    const preview = snapshot.artifacts.find((artifact) => artifact.type === "preview")
    if (!preview) throw new Error("fixture needs a preview artifact")
    snapshot.artifacts = [
      { ...preview, id: "preview-b", variant: { id: "b", groupId: "onboarding", label: "Variant B", order: 1 } },
      { ...preview, id: "preview-a", variant: { id: "a", groupId: "onboarding", label: "Variant A", order: 0 } },
    ]

    const rows = artifactRows(snapshot, "session-billing")

    expect(rows.map((row) => row.variantLabel)).toEqual(["Variant A", "Variant B"])
  })
})

describe("artifactBody", () => {
  it("refuses to render what it does not hold", () => {
    const snapshot = workspace()
    const preview = snapshot.artifacts.find((artifact) => artifact.type === "preview")
    if (!preview) throw new Error("fixture needs a preview artifact")

    expect(artifactBody(preview)).toEqual({
      readable: false,
      reason: "A preview is fetched from the machine with a signed grant.",
    })
  })

  it("counts the lines it left off rather than truncating in silence", () => {
    const snapshot = workspace()
    const plan = snapshot.artifacts.find((artifact) => artifact.type === "plan")
    if (!plan) throw new Error("fixture needs a plan artifact")
    plan.content = Array.from({ length: maximumRenderedArtifactLines + 12 }, (_v, i) => `line ${i}`)
      .join("\n")

    const body = artifactBody(plan)

    expect(body.readable && body.lines).toHaveLength(maximumRenderedArtifactLines)
    expect(body.readable && body.omitted).toBe(12)
  })

  it("reports nothing omitted for a body that fits", () => {
    const snapshot = workspace()
    const plan = snapshot.artifacts.find((artifact) => artifact.type === "plan")
    if (!plan) throw new Error("fixture needs a plan artifact")
    plan.content = "one\ntwo"

    expect(artifactBody(plan)).toEqual({ readable: true, lines: ["one", "two"], omitted: 0 })
  })
})

describe("diffLines", () => {
  it("marks which side of the change each line is on", () => {
    const lines = diffLines([
      "--- a/replay.ts",
      "+++ b/replay.ts",
      "@@ -1,3 +1,3 @@",
      " kept",
      "-gone",
      "+added",
    ])

    expect(lines.map((line) => line.tone)).toEqual([
      "meta",
      "meta",
      "meta",
      "context",
      "removed",
      "added",
    ])
  })
})

describe("findArtifact", () => {
  it("returns nothing for an artifact this snapshot does not have", () => {
    expect(findArtifact(workspace(), "artifact-missing")).toBeUndefined()
    expect(findArtifact(workspace(), "artifact-plan")?.id).toBe("artifact-plan")
  })
})

describe("previewVariants", () => {
  it("lists the group in the daemon's order, this render included", () => {
    const snapshot = workspace()
    const mine = snapshot.artifacts.find((artifact) => artifact.type === "preview")
    if (!mine) throw new Error("fixture needs a preview")
    mine.variant = { id: "b", groupId: "g", label: "B", order: 1 }
    snapshot.artifacts.push(
      { ...mine, id: "artifact-preview-c", variant: { id: "c", groupId: "g", label: "C", order: 2 } },
      { ...mine, id: "artifact-preview-a", variant: { id: "a", groupId: "g", label: "A", order: 0 } },
      { ...mine, id: "artifact-other", variant: { id: "x", groupId: "other", label: "X", order: 0 } },
    )

    expect(previewVariants(snapshot, mine.id)).toEqual([
      { id: "artifact-preview-a", label: "A" },
      { id: mine.id, label: "B" },
      { id: "artifact-preview-c", label: "C" },
    ])
  })

  it("gives a render with no group no tabs", () => {
    const snapshot = workspace()
    const mine = snapshot.artifacts.find((artifact) => artifact.type === "preview")
    if (!mine) throw new Error("fixture needs a preview")
    expect(previewVariants(snapshot, mine.id)).toEqual([])
  })
})
