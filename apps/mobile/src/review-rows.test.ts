import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  annotationRows,
  openAnnotationCount,
  reviewRows,
  reviewSummary,
} from "./review-rows"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("annotationRows", () => {
  it("numbers the comments on one artifact and leaves the others alone", () => {
    const snapshot = workspace()
    const artifactId = snapshot.annotations[0]?.artifactId ?? ""
    const rows = annotationRows(snapshot, artifactId)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((row) => row.pin)).toEqual(rows.map((_, index) => String(index + 1)))
    expect(rows.every((row) => snapshot.annotations
      .some((annotation) => annotation.id === row.id && annotation.artifactId === artifactId)))
      .toBe(true)
  })

  it("anchors on the quoted words when there are any, and the selector otherwise", () => {
    const snapshot = workspace()
    const annotation = snapshot.annotations[0]
    if (!annotation) throw new Error("the demo workspace carries no annotation")
    annotation.anchor = { cssSelector: "header h1" }
    expect(annotationRows(snapshot, annotation.artifactId)[0]?.anchor).toBe("header h1")
    annotation.anchor = { cssSelector: "header h1", textQuote: "Replay operations" }
    expect(annotationRows(snapshot, annotation.artifactId)[0]?.anchor).toBe("Replay operations")
  })

  it("names the device that left the comment without calling this phone a phone", () => {
    const snapshot = workspace()
    const annotation = snapshot.annotations.find((entry) => entry.origin === "phone")
    if (!annotation) throw new Error("the demo workspace carries no comment from a phone")
    const row = annotationRows(snapshot, annotation.artifactId)
      .find((entry) => entry.id === annotation.id)
    expect(row?.meta).toBe("this phone")
  })

  it("counts the replies on a comment that has them", () => {
    const snapshot = workspace()
    const annotation = snapshot.annotations.find((entry) => entry.thread.length === 1)
    if (!annotation) throw new Error("the demo workspace carries no answered comment")
    const row = annotationRows(snapshot, annotation.artifactId)
      .find((entry) => entry.id === annotation.id)
    expect(row?.meta).toBe(`${annotation.origin === "phone" ? "this phone" : "iPad"} · 1 reply`)
  })

  it("counts only the comments still open", () => {
    const snapshot = workspace()
    const annotation = snapshot.annotations[0]
    if (!annotation) throw new Error("the demo workspace carries no annotation")
    const before = openAnnotationCount(annotationRows(snapshot, annotation.artifactId))
    annotation.status = "resolved"
    expect(openAnnotationCount(annotationRows(snapshot, annotation.artifactId))).toBe(before - 1)
  })
})

describe("reviewRows", () => {
  it("holds every artifact the workspace has, whoever produced it", () => {
    const snapshot = workspace()
    expect(reviewRows(snapshot).map((row) => row.id).sort())
      .toEqual(snapshot.artifacts.map((artifact) => artifact.id).sort())
  })

  it("puts what still has an open comment above what does not", () => {
    const rows = reviewRows(workspace())
    const opens = rows.map((row) => row.open)
    expect([...opens].sort((left, right) => right - left)).toEqual(opens)
    expect(opens[0]).toBeGreaterThan(0)
  })

  it("names the session an artifact came from", () => {
    const snapshot = workspace()
    const artifact = snapshot.artifacts[0]
    if (!artifact) throw new Error("the demo workspace carries no artifact")
    const session = snapshot.sessions.find((entry) => entry.id === artifact.sessionId)
    expect(reviewRows(snapshot).find((row) => row.id === artifact.id)?.sessionTitle)
      .toBe(session?.title)
  })

  it("summarises what there is and what wants an answer", () => {
    const snapshot = workspace()
    const rows = reviewRows(snapshot)
    const open = snapshot.annotations.filter((entry) => entry.status === "open").length
    expect(reviewSummary(rows)).toBe(`${snapshot.artifacts.length} artifacts · ${open} open`)
  })

  it("says artifact rather than artifacts when there is one", () => {
    expect(reviewSummary([{
      id: "a",
      sessionId: "s",
      sessionTitle: "s",
      title: "a",
      detail: "plan · revision 1",
      variantLabel: undefined,
      open: 0,
      resolved: 0,
    }])).toBe("1 artifact · 0 open")
  })
})
