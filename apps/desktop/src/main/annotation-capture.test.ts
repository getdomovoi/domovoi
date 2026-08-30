import { describe, expect, it, vi } from "vitest"

import { captureAnnotationPng } from "./annotation-capture.js"

describe("captureAnnotationPng", () => {
  it("captures one bounded PNG from the owning web contents", async () => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)])
    const image = {
      getSize: () => ({ width: 320, height: 120 }),
      toPNG: () => png,
      resize: () => image,
    }
    const capturePage = vi.fn(async () => image)
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
    type TestImage = {
      getSize(): { width: number; height: number }
      resize(input: { width: number; height: number }): TestImage
      toPNG(): Uint8Array
    }
    const oversizedImage = (width: number, height: number): TestImage => ({
      getSize: () => ({ width, height }),
      resize: ({ width: nextWidth, height: nextHeight }) => oversizedImage(nextWidth, nextHeight),
      toPNG: () => Buffer.alloc(1_500_001),
    })
    await expect(captureAnnotationPng({
      capturePage: async () => oversizedImage(320, 120),
    }, { x: 0, y: 0, width: 320, height: 120 })).rejects.toThrow("Annotation capture exceeds byte limit")
  })

  it("downscales HiDPI physical captures without upscaling", async () => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)])
    const resize = vi.fn(({ width, height }: { width: number; height: number }) => ({
      getSize: () => ({ width, height }),
      resize,
      toPNG: () => png,
    }))
    const capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 4096, height: 2400 }),
      resize,
      toPNG: () => Buffer.alloc(1_500_001),
    }))

    await expect(captureAnnotationPng({ capturePage }, {
      x: 0,
      y: 0,
      width: 2048,
      height: 1200,
    })).resolves.toMatchObject({ width: 2048, height: 1200, data: png.toString("base64") })
    expect(resize).toHaveBeenCalledWith(expect.objectContaining({ width: 2048, height: 1200 }))
  })

  it("shrinks encoded output again and rejects malformed PNG bytes", async () => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)])
    const resize = vi.fn(({ width, height }: { width: number; height: number }) => ({
      getSize: () => ({ width, height }),
      resize,
      toPNG: () => width > 1024 ? Buffer.alloc(1_500_001) : png,
    }))
    const target = {
      capturePage: vi.fn(async () => ({
        getSize: () => ({ width: 3000, height: 2400 }),
        resize,
        toPNG: () => Buffer.alloc(1_500_001),
      })),
    }
    const result = await captureAnnotationPng(target, { x: 0, y: 0, width: 1000, height: 800 })
    expect(result.width).toBeLessThanOrEqual(1024)
    expect(result.height).toBeLessThanOrEqual(1024)
    expect(resize).toHaveBeenCalledTimes(2)

    await expect(captureAnnotationPng({ capturePage: async () => ({
      getSize: () => ({ width: 10, height: 10 }),
      resize,
      toPNG: () => Buffer.alloc(16, 1),
    }) }, { x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow("Invalid annotation capture PNG")
  })
})
