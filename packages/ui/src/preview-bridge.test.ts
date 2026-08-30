import { describe, expect, it } from "vitest"

import {
  anchorResolutionMapFor,
  anchorResolutionsFor,
  createPreviewBridgeChannel,
  previewResolveAnchorsMessage,
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

  it("builds bounded resolution requests and validates correlated results", () => {
    const annotations = Array.from({ length: 101 }, (_, index) => ({
      annotationId: `annotation-${index}`,
      anchor: { textQuote: `Quote ${index}` },
    }))
    const request = previewResolveAnchorsMessage(
      "preview_channel_123456",
      "artifact-preview",
      annotations,
    )
    expect(request.annotations).toHaveLength(100)

    const result = {
      type: "domovoi.preview.anchor-resolutions",
      channel: request.channel,
      artifactId: request.artifactId,
      resolutions: [{ annotationId: "annotation-1", status: "unresolved" }],
    }
    expect(anchorResolutionsFor(result, request.channel, request.artifactId)).toEqual(result)
    expect(anchorResolutionsFor(
      { ...result, channel: "preview_channel_other" },
      request.channel,
      request.artifactId,
    )).toBeUndefined()
  })

  it("marks missing resolutions unresolved and ignores unknown annotation IDs", () => {
    const resolutions = anchorResolutionMapFor(["annotation-1", "annotation-2"], [
      { annotationId: "annotation-1", status: "resolved", strategy: "selector" },
      { annotationId: "annotation-other", status: "resolved", strategy: "text-quote" },
    ])

    expect([...resolutions]).toEqual([
      ["annotation-1", "selector"],
      ["annotation-2", "unresolved"],
    ])
  })
})
