import { describe, expect, it } from "vitest"

import { createPreviewBridgeChannel, previewSelectionFor } from "./preview-bridge"

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
})
