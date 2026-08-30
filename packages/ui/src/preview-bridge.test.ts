import { describe, expect, it } from "vitest"

import {
  anchorResolutionsFor,
  createPreviewBridgeChannel,
  mergeAnchorResolutionBatch,
  previewReadyFor,
  previewResolveAnchorMessages,
  previewSelectionFor,
} from "./preview-bridge"

const selection = {
  type: "domovoi.preview.selection",
  channel: "preview_channel_123456",
  artifactId: "artifact-preview",
  anchor: { cssSelector: "main > h1", textQuote: "Migration plan" },
  label: "h1 · Migration plan",
}

describe("previewSelectionFor", () => {
  it("creates schema-compatible channels with a UUID fallback", () => {
    expect(createPreviewBridgeChannel(() => "123e4567-e89b-12d3-a456-426614174000")).toBe(
      "preview_123e4567e89b12d3a456426614174000",
    )
    expect(createPreviewBridgeChannel(null, () => 0.5)).toMatch(/^preview_[a-z0-9]{32}$/)
  })

  it("accepts a selection for the active channel and artifact", () => {
    expect(previewSelectionFor(
      selection,
      "preview_channel_123456",
      "artifact-preview",
    )).toEqual(selection)
  })

  it("rejects malformed and cross-preview messages", () => {
    expect(previewSelectionFor(
      { ...selection, channel: "preview_channel_other" },
      "preview_channel_123456",
      "artifact-preview",
    )).toBeUndefined()
    expect(previewSelectionFor(
      { ...selection, artifactId: "artifact-other" },
      "preview_channel_123456",
      "artifact-preview",
    )).toBeUndefined()
    expect(previewSelectionFor({ type: "domovoi.preview.selection" }, "preview_channel_123456", "artifact-preview")).toBeUndefined()
  })

  it("builds sequential bounded requests for every annotation", () => {
    const annotations = Array.from({ length: 205 }, (_, index) => ({
      annotationId: `annotation-${index}`,
      anchor: { textQuote: `Quote ${index}` },
    }))
    let requestIndex = 0
    const requests = previewResolveAnchorMessages(
      "preview_channel_123456",
      "artifact-preview",
      annotations,
      () => `request_channel_${String(requestIndex++).padStart(16, "0")}`,
    )
    expect(requests.map((request) => request.annotations.length)).toEqual([100, 100, 5])
    expect(requests.flatMap((request) => request.annotations.map((item) => item.annotationId))).toEqual(
      annotations.map((item) => item.annotationId),
    )

    const result = {
      type: "domovoi.preview.anchor-resolutions",
      channel: requests[0]!.channel,
      artifactId: requests[0]!.artifactId,
      requestId: requests[0]!.requestId,
      resolutions: [{ annotationId: "annotation-1", status: "unresolved" }],
    }
    expect(anchorResolutionsFor(
      result,
      requests[0]!.channel,
      requests[0]!.artifactId,
      requests[0]!.requestId,
      ["annotation-1"],
    )).toEqual(result)
    expect(anchorResolutionsFor(
      { ...result, channel: "preview_channel_other" },
      requests[0]!.channel,
      requests[0]!.artifactId,
      requests[0]!.requestId,
      ["annotation-1"],
    )).toBeUndefined()
    expect(anchorResolutionsFor(
      { ...result, requestId: requests[1]!.requestId },
      requests[0]!.channel,
      requests[0]!.artifactId,
      requests[0]!.requestId,
      ["annotation-1"],
    )).toBeUndefined()
    expect(anchorResolutionsFor(
      { ...result, resolutions: [{ annotationId: "annotation-other", status: "unresolved" }] },
      requests[0]!.channel,
      requests[0]!.artifactId,
      requests[0]!.requestId,
      ["annotation-1"],
    )).toBeUndefined()
    expect(anchorResolutionsFor(
      result,
      requests[0]!.channel,
      requests[0]!.artifactId,
      requests[0]!.requestId,
      ["annotation-1", "annotation-2"],
    )).toBeUndefined()
  })

  it("merges completed batches without classifying unprocessed IDs", () => {
    const first = mergeAnchorResolutionBatch(new Map(), [
      { annotationId: "annotation-1", status: "resolved", strategy: "selector" },
    ])
    const resolutions = mergeAnchorResolutionBatch(first, [
      { annotationId: "annotation-101", status: "unresolved" },
    ])

    expect([...resolutions]).toEqual([
      ["annotation-1", "selector"],
      ["annotation-101", "unresolved"],
    ])
    expect(resolutions.has("annotation-205")).toBe(false)
  })

  it("accepts only the active preview ready signal", () => {
    const ready = {
      type: "domovoi.preview.ready",
      channel: "preview_channel_123456",
      artifactId: "artifact-preview",
    }
    expect(previewReadyFor(ready, ready.channel, ready.artifactId)).toBe(true)
    expect(previewReadyFor({ ...ready, channel: "preview_channel_other" }, ready.channel, ready.artifactId)).toBe(false)
  })
})
