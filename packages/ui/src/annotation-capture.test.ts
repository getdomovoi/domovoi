import { describe, expect, it, vi } from "vitest"

import { annotationCaptureRect, annotationCaptureUpload } from "./annotation-capture"

describe("annotationCaptureRect", () => {
  it("translates and clips iframe-relative bounds into window coordinates", () => {
    expect(annotationCaptureRect(
      { left: 300, top: 120, width: 800, height: 600 },
      { x: 760, y: 560, width: 200, height: 100 },
      { width: 1200, height: 800 },
    )).toEqual({ x: 1060, y: 680, width: 40, height: 40 })
  })

  it("rejects invisible and non-finite selections", () => {
    expect(annotationCaptureRect(
      { left: 300, top: 120, width: 800, height: 600 },
      { x: 900, y: 700, width: 20, height: 20 },
      { width: 1200, height: 800 },
    )).toBeUndefined()
    expect(annotationCaptureRect(
      { left: 0, top: 0, width: 800, height: 600 },
      { x: Number.NaN, y: 0, width: 20, height: 20 },
      { width: 1200, height: 800 },
    )).toBeUndefined()
  })

  it("requests one desktop capture and falls back without blocking the annotation", async () => {
    const capture = vi.fn(async () => ({
      mimeType: "image/png" as const,
      width: 100,
      height: 40,
      data: "iVBORw0KGgo=",
    }))
    await expect(annotationCaptureUpload(
      capture,
      { left: 300, top: 120, width: 800, height: 600 },
      { x: 10, y: 20, width: 100, height: 40 },
      { width: 1200, height: 800 },
      7,
    )).resolves.toMatchObject({ artifactRevision: 7, data: "iVBORw0KGgo=" })
    expect(capture).toHaveBeenCalledWith({ x: 310, y: 140, width: 100, height: 40 })
    await expect(annotationCaptureUpload(
      async () => { throw new Error("capture unavailable") },
      { left: 300, top: 120, width: 800, height: 600 },
      { x: 10, y: 20, width: 100, height: 40 },
      { width: 1200, height: 800 },
      7,
    )).resolves.toBeUndefined()
  })
})
