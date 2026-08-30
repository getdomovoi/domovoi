import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AnnotationVisualContextService,
  type AnnotationCropRenderer,
} from "./annotation-visual-context.js"

const roots: string[] = []
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)])

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("AnnotationVisualContextService", () => {
  it("stores bounded crop bytes outside durable snapshot metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-crops-"))
    roots.push(root)
    const renderer = {
      capture: vi.fn(async () => ({ mimeType: "image/png" as const, bytes: png, width: 640, height: 320 })),
    } satisfies AnnotationCropRenderer
    const service = new AnnotationVisualContextService({ root, renderer })

    const result = await service.capture({
      artifactId: "artifact-preview",
      artifactRevision: 4,
      htmlPath: "/worktree/preview.html",
      bbox: { x: 20, y: 40, width: 640, height: 320 },
    })

    expect(renderer.capture).toHaveBeenCalledWith(expect.objectContaining({
      htmlPath: "/worktree/preview.html",
      network: "disabled",
      maxWidth: 2048,
      maxHeight: 2048,
      maxBytes: 1_500_000,
    }))
    expect(result).toMatchObject({
      status: "available",
      artifactRevision: 4,
      mimeType: "image/png",
      width: 640,
      height: 320,
      byteLength: png.byteLength,
    })
    expect(JSON.stringify(result)).not.toContain(png.toString("base64"))
    if (result.status !== "available") throw new Error("crop should be available")
    await expect(service.read(result.ref, "image/png")).resolves.toEqual(new Uint8Array(png))
    await expect(service.read(result.ref, "image/jpeg")).rejects.toThrow("Stored crop MIME type does not match metadata")
    await expect(readFile(join(root, `${result.ref}.png`))).resolves.toEqual(png)
    await expect(service.storeUpload({
      artifactRevision: 5,
      mimeType: "image/png",
      bytes: png,
      width: 640,
      height: 320,
    })).resolves.toMatchObject({ status: "available", ref: result.ref, artifactRevision: 5 })
  })

  it("fails closed for unavailable, oversized, malformed, and traversal results", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-crops-"))
    roots.push(root)
    const unavailable = new AnnotationVisualContextService({ root })
    await expect(unavailable.capture({
      artifactId: "artifact-preview",
      artifactRevision: 1,
      htmlPath: "/worktree/preview.html",
      bbox: { x: 0, y: 0, width: 100, height: 100 },
    })).resolves.toMatchObject({ status: "unavailable", reason: "renderer-unavailable" })

    const oversized = new AnnotationVisualContextService({
      root,
      renderer: { capture: async () => ({
        mimeType: "image/png",
        bytes: Buffer.alloc(1_500_001),
        width: 100,
        height: 100,
      }) },
    })
    await expect(oversized.capture({
      artifactId: "artifact-preview",
      artifactRevision: 1,
      htmlPath: "/worktree/preview.html",
      bbox: { x: 0, y: 0, width: 100, height: 100 },
    })).resolves.toMatchObject({ status: "unavailable", reason: "invalid-capture" })
    await expect(unavailable.storeUpload({
      artifactRevision: 2,
      mimeType: "image/png",
      bytes: Buffer.alloc(12, 1),
      width: 4,
      height: 4,
    })).resolves.toMatchObject({ status: "unavailable", reason: "invalid-capture" })
    await expect(unavailable.read("../../secret", "image/png")).rejects.toThrow("Invalid crop reference")
  })
})
