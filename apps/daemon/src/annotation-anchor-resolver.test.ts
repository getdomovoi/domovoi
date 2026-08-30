import { describe, expect, it } from "vitest"

import { resolveAnnotationAnchor, type AnchorCandidate } from "./annotation-anchor-resolver.js"

const candidate = (
  id: string,
  text: string,
  x: number,
  y: number,
): AnchorCandidate<string> => ({
  value: id,
  text,
  bbox: { x, y, width: 120, height: 40 },
})

describe("resolveAnnotationAnchor", () => {
  it("keeps a selector only while its normalized quote still matches", () => {
    const selected = candidate("selected", "  Review\n this   migration step ", 500, 500)

    expect(resolveAnnotationAnchor({
      cssSelector: "main > section",
      textQuote: "Review this migration step",
      bbox: { x: 20, y: 20, width: 120, height: 40 },
    }, [candidate("near-old-box", "Wrong content", 20, 20)], selected)).toMatchObject({
      status: "resolved",
      strategy: "selector",
      value: "selected",
    })

    expect(resolveAnnotationAnchor({
      cssSelector: "main > section",
      textQuote: "Review this migration step",
    }, [candidate("moved", "Review this migration step", 400, 300)], candidate("stale", "Replaced", 20, 20))).toMatchObject({
      status: "resolved",
      strategy: "text-quote",
      value: "moved",
    })
  })

  it("uses bbox proximity for an ambiguous or unavailable quote", () => {
    const near = candidate("near", "Duplicate", 24, 90)
    const far = candidate("far", "Duplicate", 600, 700)
    expect(resolveAnnotationAnchor({
      textQuote: "Duplicate",
      bbox: { x: 20, y: 88, width: 120, height: 40 },
    }, [far, near])).toMatchObject({ status: "resolved", strategy: "bounding-box", value: "near" })

    expect(resolveAnnotationAnchor({
      textQuote: "Removed copy",
      bbox: { x: 20, y: 88, width: 120, height: 40 },
    }, [far, candidate("replacement", "New copy", 24, 90)])).toMatchObject({
      status: "resolved",
      strategy: "bounding-box",
      value: "replacement",
    })
  })

  it("returns unresolved instead of choosing an ambiguous or distant element", () => {
    expect(resolveAnnotationAnchor(
      { textQuote: "Duplicate" },
      [candidate("one", "Duplicate", 10, 10), candidate("two", "Duplicate", 20, 20)],
    )).toEqual({ status: "unresolved" })
    expect(resolveAnnotationAnchor(
      { bbox: { x: 0, y: 0, width: 20, height: 20 } },
      [candidate("far", "Far away", 900, 900)],
    )).toEqual({ status: "unresolved" })
    expect(resolveAnnotationAnchor(
      { bbox: { x: 10, y: 10, width: 20, height: 20 } },
      [candidate("one", "One", 10, 10), candidate("two", "Two", 10, 10)],
    )).toEqual({ status: "unresolved" })
    expect(resolveAnnotationAnchor(
      { bbox: { x: 10, y: 10, width: 20, height: 20 } },
      [candidate("one", "One", 12, 10), candidate("two", "Two", 18, 10)],
    )).toEqual({ status: "unresolved" })
  })
})
