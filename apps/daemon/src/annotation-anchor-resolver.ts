import type { Annotation } from "@getdomovoi/protocol"

export interface AnchorCandidate<Value> {
  value: Value
  text: string
  bbox: { x: number; y: number; width: number; height: number }
}

export type AnchorResolution<Value> =
  | { status: "resolved"; strategy: "selector" | "text-quote" | "bounding-box"; value: Value }
  | { status: "unresolved" }

export function resolveAnnotationAnchor<Value>(
  anchor: Annotation["anchor"],
  candidates: AnchorCandidate<Value>[],
  selectorCandidate?: AnchorCandidate<Value>,
): AnchorResolution<Value> {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim()
  const quote = anchor.textQuote ? normalize(anchor.textQuote) : ""
  if (selectorCandidate && (!quote || normalize(selectorCandidate.text) === quote)) {
    return { status: "resolved", strategy: "selector", value: selectorCandidate.value }
  }

  const quoteMatches = quote
    ? candidates.filter((candidate) => normalize(candidate.text) === quote)
    : []
  if (quoteMatches.length === 1) {
    return { status: "resolved", strategy: "text-quote", value: quoteMatches[0]!.value }
  }
  if (!anchor.bbox) return { status: "unresolved" }

  const pool = quoteMatches.length > 1 ? quoteMatches : candidates
  if (pool.length === 0) return { status: "unresolved" }
  const oldCenterX = anchor.bbox.x + anchor.bbox.width / 2
  const oldCenterY = anchor.bbox.y + anchor.bbox.height / 2
  const ranked = pool.map((candidate) => {
    const centerX = candidate.bbox.x + candidate.bbox.width / 2
    const centerY = candidate.bbox.y + candidate.bbox.height / 2
    return {
      candidate,
      distance: Math.hypot(centerX - oldCenterX, centerY - oldCenterY),
    }
  }).sort((left, right) => left.distance - right.distance)
  const best = ranked[0]!
  const maximumDistance = Math.max(
    96,
    Math.min(240, Math.hypot(anchor.bbox.width, anchor.bbox.height) * 2),
  )
  if (
    best.distance > maximumDistance
    || (ranked[1] && Math.abs(ranked[1].distance - best.distance) < 8)
  ) return { status: "unresolved" }
  return { status: "resolved", strategy: "bounding-box", value: best.candidate.value }
}
