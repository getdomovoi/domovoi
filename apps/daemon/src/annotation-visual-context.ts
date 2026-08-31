import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import type { Annotation } from "@getdomovoi/protocol"

export const maximumAnnotationCropBytes = 1_500_000
export const maximumAnnotationCropDimension = 2048
export const maximumStoredAnnotationCropFiles = 64
export const maximumStoredAnnotationCropBytes = 48 * 1_024 * 1_024

const storedCropNamePattern = /^(crop-[a-f0-9]{64})\.(png|jpg|webp)$/

type VisualContext = NonNullable<Annotation["visualContext"]>
type Bbox = NonNullable<Annotation["anchor"]["bbox"]>
type CropMimeType = "image/png" | "image/jpeg" | "image/webp"

export interface AnnotationCropRenderer {
  capture(input: {
    htmlPath: string
    bbox: Bbox
    network: "disabled"
    maxWidth: number
    maxHeight: number
    maxBytes: number
  }): Promise<{
    mimeType: CropMimeType
    bytes: Uint8Array
    width: number
    height: number
  } | undefined>
}

export interface AnnotationVisualContextReader {
  read(ref: string, expectedMimeType: CropMimeType): Promise<Uint8Array>
}

export class AnnotationVisualContextService implements AnnotationVisualContextReader {
  readonly #root: string
  readonly #renderer: AnnotationCropRenderer | undefined
  readonly #maximumFileCount: number
  readonly #maximumTotalBytes: number
  readonly #protectedRefs: (() => Iterable<string> | Promise<Iterable<string>>) | undefined
  readonly #removeFile: (path: string) => Promise<void>
  readonly #reportRetentionOverflow: ((input: { fileCount: number; totalBytes: number }) => void) | undefined
  readonly #reportRetentionError: ((error: unknown) => void) | undefined
  readonly #scheduleRetentionReconciliation: (task: () => Promise<void>) => void
  readonly #reservedRefs = new Map<string, number>()
  readonly #publishingRefs = new Map<string, number>()
  #pruneTail: Promise<void> = Promise.resolve()

  constructor(options: {
    root: string
    renderer?: AnnotationCropRenderer
    maximumFileCount?: number
    maximumTotalBytes?: number
    protectedRefs?: () => Iterable<string> | Promise<Iterable<string>>
    removeFile?: (path: string) => Promise<void>
    reportRetentionOverflow?: (input: { fileCount: number; totalBytes: number }) => void
    reportRetentionError?: (error: unknown) => void
    scheduleRetentionReconciliation?: (task: () => Promise<void>) => void
  }) {
    this.#root = options.root
    this.#renderer = options.renderer
    this.#maximumFileCount = Math.max(1, options.maximumFileCount ?? maximumStoredAnnotationCropFiles)
    this.#maximumTotalBytes = Math.max(1, options.maximumTotalBytes ?? maximumStoredAnnotationCropBytes)
    this.#protectedRefs = options.protectedRefs
    this.#removeFile = options.removeFile ?? unlink
    this.#reportRetentionOverflow = options.reportRetentionOverflow
    this.#reportRetentionError = options.reportRetentionError
    this.#scheduleRetentionReconciliation = options.scheduleRetentionReconciliation
      ?? ((task) => { setImmediate(() => { void task().catch(() => {}) }) })
  }

  async capture(input: {
    artifactId: string
    artifactRevision: number
    htmlPath: string
    bbox?: Bbox
  }): Promise<VisualContext> {
    if (!input.bbox) return unavailable(input.artifactRevision, "missing-bounds")
    if (!isAbsolute(input.htmlPath) || !input.htmlPath.toLowerCase().endsWith(".html")) {
      return unavailable(input.artifactRevision, "artifact-unavailable")
    }
    if (!this.#renderer) return unavailable(input.artifactRevision, "renderer-unavailable")
    const bbox = boundedBbox(input.bbox)
    if (!bbox) return unavailable(input.artifactRevision, "invalid-capture")
    let result: Awaited<ReturnType<AnnotationCropRenderer["capture"]>>
    try {
      result = await this.#renderer.capture({
        htmlPath: input.htmlPath,
        bbox,
        network: "disabled",
        maxWidth: maximumAnnotationCropDimension,
        maxHeight: maximumAnnotationCropDimension,
        maxBytes: maximumAnnotationCropBytes,
      })
    } catch {
      return unavailable(input.artifactRevision, "capture-failed")
    }
    if (!result || !validCapture(result)) return unavailable(input.artifactRevision, "invalid-capture")
    return await this.storeUpload({ ...result, artifactRevision: input.artifactRevision })
  }

  async storeUpload(input: {
    artifactRevision: number
    mimeType: CropMimeType
    bytes: Uint8Array
    width: number
    height: number
  }): Promise<VisualContext> {
    if (!validCapture(input)) return unavailable(input.artifactRevision, "invalid-capture")
    const digest = createHash("sha256").update(input.bytes).digest("hex")
    const ref = `crop-${digest}`
    const extension = extensionFor(input.mimeType)
    this.#reservedRefs.set(ref, (this.#reservedRefs.get(ref) ?? 0) + 1)
    let publish = false
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      try {
        await writeFile(join(this.#root, `${ref}.${extension}`), input.bytes, {
          flag: "wx",
          mode: 0o600,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      await this.#serializedPrune(ref)
      publish = true
      return {
        status: "available",
        ref,
        artifactRevision: input.artifactRevision,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        byteLength: input.bytes.byteLength,
      }
    } finally {
      const reservations = this.#reservedRefs.get(ref) ?? 1
      if (reservations === 1) this.#reservedRefs.delete(ref)
      else this.#reservedRefs.set(ref, reservations - 1)
      if (publish) this.#deferRetentionReconciliation(ref)
    }
  }

  #deferRetentionReconciliation(ref: string): void {
    this.#publishingRefs.set(ref, (this.#publishingRefs.get(ref) ?? 0) + 1)
    const reconcile = async () => {
      try {
        await this.#serializedReconciliation(ref)
      } catch (error) {
        this.#reportReconciliationError(error)
      }
    }
    try {
      this.#scheduleRetentionReconciliation(reconcile)
    } catch (error) {
      this.#releasePublication(ref)
      this.#reportReconciliationError(error)
    }
  }

  #reportReconciliationError(error: unknown): void {
    try {
      this.#reportRetentionError?.(error)
    } catch {}
  }

  #releasePublication(ref: string): void {
    const publications = this.#publishingRefs.get(ref) ?? 1
    if (publications === 1) this.#publishingRefs.delete(ref)
    else this.#publishingRefs.set(ref, publications - 1)
  }

  async #serializedPrune(currentRef?: string): Promise<void> {
    const prune = this.#pruneTail.then(() => this.#prune(currentRef))
    this.#pruneTail = prune.catch(() => {})
    await prune
  }

  async #serializedReconciliation(ref: string): Promise<void> {
    const prune = this.#pruneTail.then(async () => {
      this.#releasePublication(ref)
      await this.#prune()
    })
    this.#pruneTail = prune.catch(() => {})
    await prune
  }

  async #prune(currentRef?: string): Promise<void> {
    const protectedRefs = new Set<string>(currentRef ? [currentRef] : [])
    for (const ref of await this.#protectedRefs?.() ?? []) {
      if (/^crop-[a-f0-9]{64}$/.test(ref)) protectedRefs.add(ref)
    }
    const files: Array<{ name: string; ref: string; size: number; mtimeMs: number }> = []
    let entries: Dirent<string>[]
    try {
      entries = await readdir(this.#root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = storedCropNamePattern.exec(entry.name)
      if (!match) continue
      try {
        const info = await stat(join(this.#root, entry.name))
        files.push({ name: entry.name, ref: match[1]!, size: info.size, mtimeMs: info.mtimeMs })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
    let fileCount = files.length
    let totalBytes = files.reduce((total, file) => total + file.size, 0)
    for (const file of files) {
      if (fileCount <= this.#maximumFileCount && totalBytes <= this.#maximumTotalBytes) break
      if (
        protectedRefs.has(file.ref)
        || this.#reservedRefs.has(file.ref)
        || this.#publishingRefs.has(file.ref)
      ) continue
      try {
        await this.#removeFile(join(this.#root, file.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      fileCount -= 1
      totalBytes -= file.size
    }
    if (fileCount > this.#maximumFileCount || totalBytes > this.#maximumTotalBytes) {
      this.#reportRetentionOverflow?.({ fileCount, totalBytes })
    }
  }

  async read(ref: string, expectedMimeType: CropMimeType): Promise<Uint8Array> {
    if (!/^crop-[a-f0-9]{64}$/.test(ref)) throw new Error("Invalid crop reference")
    for (const extension of ["png", "jpg", "webp"] as const) {
      try {
        const bytes = await readFile(join(this.#root, `${ref}.${extension}`))
        if (bytes.byteLength === 0 || bytes.byteLength > maximumAnnotationCropBytes) {
          throw new Error("Stored crop exceeds bounds")
        }
        const mimeType = extension === "png"
          ? "image/png"
          : extension === "jpg" ? "image/jpeg" : "image/webp"
        if (mimeType !== expectedMimeType) {
          throw new Error("Stored crop MIME type does not match metadata")
        }
        if (!validImageBytes(mimeType, bytes)) throw new Error("Stored crop is malformed")
        return new Uint8Array(bytes)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    throw new Error("Stored crop is unavailable")
  }
}

function unavailable(
  artifactRevision: number,
  reason: Extract<VisualContext, { status: "unavailable" }>["reason"],
): VisualContext {
  return { status: "unavailable", artifactRevision, reason }
}

function boundedBbox(bbox: Bbox): Bbox | undefined {
  if (
    ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)
    || bbox.x < 0
    || bbox.y < 0
    || bbox.width <= 0
    || bbox.height <= 0
  ) return undefined
  return {
    x: bbox.x,
    y: bbox.y,
    width: Math.min(bbox.width, maximumAnnotationCropDimension),
    height: Math.min(bbox.height, maximumAnnotationCropDimension),
  }
}

function validCapture(result: {
  mimeType: CropMimeType
  bytes: Uint8Array
  width: number
  height: number
}): boolean {
  if (
    !Number.isInteger(result.width)
    || !Number.isInteger(result.height)
    || result.width < 1
    || result.height < 1
    || result.width > maximumAnnotationCropDimension
    || result.height > maximumAnnotationCropDimension
    || result.bytes.byteLength < 8
    || result.bytes.byteLength > maximumAnnotationCropBytes
  ) return false
  return validImageBytes(result.mimeType, result.bytes)
}

function validImageBytes(mimeType: CropMimeType, bytes: Uint8Array): boolean {
  if (mimeType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  }
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8
  return bytes[0] === 0x52 && bytes[1] === 0x49
    && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45
    && bytes[10] === 0x42 && bytes[11] === 0x50
}

function extensionFor(mimeType: CropMimeType): "png" | "jpg" | "webp" {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp"
}
