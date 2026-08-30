import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import type { Annotation } from "@getdomovoi/protocol"

export const maximumAnnotationCropBytes = 1_500_000
export const maximumAnnotationCropDimension = 2048

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

  constructor(options: { root: string; renderer?: AnnotationCropRenderer }) {
    this.#root = options.root
    this.#renderer = options.renderer
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
    try {
      const result = await this.#renderer.capture({
        htmlPath: input.htmlPath,
        bbox,
        network: "disabled",
        maxWidth: maximumAnnotationCropDimension,
        maxHeight: maximumAnnotationCropDimension,
        maxBytes: maximumAnnotationCropBytes,
      })
      if (!result || !validCapture(result)) {
        return unavailable(input.artifactRevision, "invalid-capture")
      }
      return await this.storeUpload({ ...result, artifactRevision: input.artifactRevision })
    } catch {
      return unavailable(input.artifactRevision, "capture-failed")
    }
  }

  async storeUpload(input: {
    artifactRevision: number
    mimeType: CropMimeType
    bytes: Uint8Array
    width: number
    height: number
  }): Promise<VisualContext> {
    if (!validCapture(input)) return unavailable(input.artifactRevision, "invalid-capture")
    try {
      const digest = createHash("sha256").update(input.bytes).digest("hex")
      const ref = `crop-${digest}`
      const extension = extensionFor(input.mimeType)
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      try {
        await writeFile(join(this.#root, `${ref}.${extension}`), input.bytes, {
          flag: "wx",
          mode: 0o600,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      return {
        status: "available",
        ref,
        artifactRevision: input.artifactRevision,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        byteLength: input.bytes.byteLength,
      }
    } catch {
      return unavailable(input.artifactRevision, "capture-failed")
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
