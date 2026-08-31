import { createHash } from "node:crypto"
import { mkdtemp, readFile, unlink, utimes } from "node:fs/promises"
import { removeScratchDirectories } from "./test-scratch.js"
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
  await removeScratchDirectories(roots.splice(0))
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

  it("prunes oldest unreferenced crops while retaining live and current refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-crops-"))
    roots.push(root)
    let protectedRef = ""
    const service = new AnnotationVisualContextService({
      root,
      maximumFileCount: 10,
      maximumTotalBytes: 150,
      protectedRefs: () => [protectedRef, "../../invalid"],
    })
    const stored = []
    for (const fill of [1, 2, 3]) {
      stored.push(await service.storeUpload({
        artifactRevision: fill,
        mimeType: "image/png",
        bytes: Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, fill)]),
        width: 8,
        height: 8,
      }))
      if (fill === 1 && stored[0]!.status === "available") protectedRef = stored[0]!.ref
    }
    const refs = stored.map((result) => {
      if (result.status !== "available") throw new Error("crops should be available")
      return result.ref
    })
    await expect(service.read(refs[0]!, "image/png")).resolves.toBeDefined()
    await expect(service.read(refs[1]!, "image/png")).rejects.toThrow("Stored crop is unavailable")
    await expect(service.read(refs[2]!, "image/png")).resolves.toBeDefined()
  })

  it("tolerates unlink races and propagates unrelated prune errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-crops-"))
    roots.push(root)
    let race = true
    const racing = new AnnotationVisualContextService({
      root,
      maximumFileCount: 1,
      maximumTotalBytes: 1_000,
      removeFile: async (path) => {
        await unlink(path)
        if (race) {
          race = false
          throw Object.assign(new Error("gone"), { code: "ENOENT" })
        }
      },
    })
    await racing.storeUpload({ artifactRevision: 1, mimeType: "image/png", bytes: png, width: 8, height: 8 })
    await expect(racing.storeUpload({
      artifactRevision: 2,
      mimeType: "image/png",
      bytes: Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 2)]),
      width: 8,
      height: 8,
    })).resolves.toMatchObject({ status: "available" })

    const failing = new AnnotationVisualContextService({
      root,
      maximumFileCount: 1,
      maximumTotalBytes: 1_000,
      removeFile: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
    })
    await expect(failing.storeUpload({
      artifactRevision: 3,
      mimeType: "image/png",
      bytes: Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 3)]),
      width: 8,
      height: 8,
    })).rejects.toThrow("denied")
  })

  it("reports bounded overflow instead of deleting protected crops", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-crops-"))
    roots.push(root)
    const protectedRefs = new Set<string>()
    const reportRetentionOverflow = vi.fn()
    const service = new AnnotationVisualContextService({
      root,
      maximumFileCount: 1,
      protectedRefs: () => protectedRefs,
      reportRetentionOverflow,
    })
    const first = await service.storeUpload({ artifactRevision: 1, mimeType: "image/png", bytes: png, width: 8, height: 8 })
    if (first.status !== "available") throw new Error("crop should be available")
    protectedRefs.add(first.ref)
    const second = await service.storeUpload({
      artifactRevision: 2,
      mimeType: "image/png",
      bytes: Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 4)]),
      width: 8,
      height: 8,
    })
    if (second.status !== "available") throw new Error("crop should be available")
    expect(reportRetentionOverflow).toHaveBeenCalledWith(expect.objectContaining({ fileCount: 2 }))
    await expect(service.read(first.ref, "image/png")).resolves.toBeDefined()
    await expect(service.read(second.ref, "image/png")).resolves.toBeDefined()
  })

  it("reserves concurrent crops while saturated retention is pruning", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-crops-"))
    roots.push(root)
    const removalStarted = deferred()
    const releaseRemoval = deferred()
    let removalCount = 0
    const service = new AnnotationVisualContextService({
      root,
      maximumFileCount: 1,
      removeFile: async (path) => {
        removalCount += 1
        if (removalCount === 1) {
          removalStarted.resolve()
          await releaseRemoval.promise
        }
        await unlink(path)
      },
    })
    const seed = await service.storeUpload({
      artifactRevision: 1,
      mimeType: "image/png",
      bytes: png,
      width: 8,
      height: 8,
    })
    if (seed.status !== "available") throw new Error("seed crop should be available")
    await utimes(join(root, `${seed.ref}.png`), new Date(0), new Date(0))

    const firstBytes = Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 2)])
    const firstStore = service.storeUpload({
      artifactRevision: 2,
      mimeType: "image/png",
      bytes: firstBytes,
      width: 8,
      height: 8,
    })
    await removalStarted.promise
    await utimes(join(root, `${cropRef(firstBytes)}.png`), new Date(1_000), new Date(1_000))
    const secondStore = service.storeUpload({
      artifactRevision: 3,
      mimeType: "image/png",
      bytes: Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 3)]),
      width: 8,
      height: 8,
    })

    const second = await secondStore
    releaseRemoval.resolve()
    const first = await firstStore
    if (first.status !== "available" || second.status !== "available") {
      throw new Error("concurrent crops should be available")
    }
    await expect(service.read(first.ref, "image/png")).resolves.toEqual(new Uint8Array(firstBytes))
    await expect(service.read(second.ref, "image/png")).resolves.toBeDefined()
  })
})

function deferred() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve: () => resolve!() }
}

function cropRef(bytes: Uint8Array): string {
  return `crop-${createHash("sha256").update(bytes).digest("hex")}`
}
