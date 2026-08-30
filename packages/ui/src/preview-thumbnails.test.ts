import { describe, expect, it, vi } from "vitest"

import { PreviewThumbnailLifecycle, previewThumbnailRect } from "./preview-thumbnails"

describe("preview thumbnails", () => {
  it("unifies pending and ready entries under one bounded lifecycle", () => {
    const revoke = vi.fn()
    const lifecycle = new PreviewThumbnailLifecycle(24, revoke)
    expect(lifecycle.reserve("artifact-a", 2)).toBe(true)
    expect(lifecycle.reserve("artifact-a", 2)).toBe(false)
    expect(lifecycle.resolve("artifact-a", 2, "blob:a2")).toBe(true)
    expect(lifecycle.readyUrls()).toEqual(new Map([["artifact-a:2", "blob:a2"]]))
    expect(lifecycle.readyUrls()).toEqual(new Map([["artifact-a:2", "blob:a2"]]))
    expect(revoke).not.toHaveBeenCalled()

    for (let revision = 3; revision <= 26; revision += 1) {
      expect(lifecycle.reserve("artifact", revision)).toBe(true)
    }
    expect(lifecycle.size).toBe(24)
    expect(revoke).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith("blob:a2")

    expect(lifecycle.resolve("artifact-a", 2, "blob:stale")).toBe(false)
    expect(revoke).toHaveBeenCalledWith("blob:stale")
    lifecycle.fail("artifact", 4)
    expect(lifecycle.reserve("artifact", 4)).toBe(true)
    lifecycle.clear()
    expect(lifecycle.size).toBe(0)
  })

  it("bounds captures to a small visible preview", () => {
    expect(previewThumbnailRect({ left: 20.2, top: 30.7, width: 1200, height: 900 }, { width: 1440, height: 1000 }))
      .toEqual({ x: 21, y: 31, width: 320, height: 180 })
  })
})
