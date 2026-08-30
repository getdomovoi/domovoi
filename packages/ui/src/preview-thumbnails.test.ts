import { describe, expect, it } from "vitest"

import { previewThumbnailRect, releasePreviewThumbnail, reservePreviewThumbnail } from "./preview-thumbnails"

describe("preview thumbnails", () => {
  it("captures each artifact revision at most once", () => {
    const reserved = new Set<string>()
    expect(reservePreviewThumbnail(reserved, "artifact-a", 2)).toBe(true)
    expect(reservePreviewThumbnail(reserved, "artifact-a", 2)).toBe(false)
    expect(reservePreviewThumbnail(reserved, "artifact-a", 3)).toBe(true)
  })

  it("allows retry after failure and caps retained reservations", () => {
    const reserved = new Set<string>()
    expect(reservePreviewThumbnail(reserved, "failed", 1)).toBe(true)
    releasePreviewThumbnail(reserved, "failed", 1)
    expect(reservePreviewThumbnail(reserved, "failed", 1)).toBe(true)
    releasePreviewThumbnail(reserved, "failed", 1)
    for (let revision = 1; revision <= 30; revision += 1) {
      expect(reservePreviewThumbnail(reserved, "artifact", revision)).toBe(true)
    }
    expect(reserved.size).toBe(24)
    expect(reserved.has("artifact:1")).toBe(false)
    expect(reserved.has("artifact:30")).toBe(true)
  })

  it("bounds captures to a small visible preview", () => {
    expect(previewThumbnailRect({ left: 20.2, top: 30.7, width: 1200, height: 900 }, { width: 1440, height: 1000 }))
      .toEqual({ x: 21, y: 31, width: 320, height: 180 })
  })
})
