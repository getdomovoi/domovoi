import { describe, expect, it, vi } from "vitest"

import { captureAnnotationPng } from "./annotation-capture.js"

describe("captureAnnotationPng", () => {
  it("captures one bounded PNG from the owning web contents", async () => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)])
    const capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 320, height: 120 }),
      toPNG: () => png,
    }))
    await expect(captureAnnotationPng({ capturePage }, {
      x: 100,
      y: 200,
      width: 320,
      height: 120,
    })).resolves.toEqual({
      mimeType: "image/png",
      width: 320,
      height: 120,
      data: png.toString("base64"),
    })
    expect(capturePage).toHaveBeenCalledWith({ x: 100, y: 200, width: 320, height: 120 })
  })

  it("rejects invalid dimensions and oversized encoded output", async () => {
    await expect(captureAnnotationPng({ capturePage: vi.fn() }, {
      x: -1,
      y: 0,
      width: 320,
      height: 120,
    })).rejects.toThrow("Invalid annotation capture bounds")
    await expect(captureAnnotationPng({ capturePage: async () => ({
      getSize: () => ({ width: 320, height: 120 }),
      toPNG: () => Buffer.alloc(1_500_001),
    }) }, { x: 0, y: 0, width: 320, height: 120 })).rejects.toThrow("Annotation capture exceeds byte limit")
  })
})
