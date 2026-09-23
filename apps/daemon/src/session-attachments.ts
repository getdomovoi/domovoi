import { randomUUID } from "node:crypto"
import { mkdir, realpath, stat, writeFile } from "node:fs/promises"
import { basename, relative, resolve } from "node:path"

import {
  canonicalBase64DecodedByteLength, maximumImageUploadBytes, maximumImageUploadDimension,
  maximumSessionAttachments, maximumTextAttachmentBytes, type ImageUpload, type SessionAttachment,
  type SessionAttachmentRefusal,
} from "@getdomovoi/protocol"
import type { AgentCapabilities, AgentVisualContext } from "./agents.js"

export class SessionAttachmentError extends Error {
  readonly refusal: SessionAttachmentRefusal
  constructor(reason: Exclude<SessionAttachmentRefusal["reason"], "image-input-unsupported">)
  constructor(reason: "image-input-unsupported", target: { model: string, imageCount: number })
  constructor(reason: SessionAttachmentRefusal["reason"], target?: { model: string, imageCount: number }) {
    super(reason === "image-input-unsupported" && target
      ? `${target.imageCount} ${target.imageCount === 1 ? "image" : "images"} cannot go to ${target.model}. Remove them or pick another model.`
      : reason === "invalid-text"
        ? "The text attachment is empty or exceeds the 256 KB limit."
        : reason === "invalid-workspace-file"
          ? "The attached path must name a bounded file inside the session worktree."
          : "An attachment is not a bounded PNG or JPEG matching its declared dimensions.")
    this.refusal = reason === "image-input-unsupported" && target
      ? { kind: "session-attachment-refused", reason, code: "attach.image.model_no_input", model: target.model, imageCount: target.imageCount }
      : { kind: "session-attachment-refused", reason: reason as Exclude<typeof reason, "image-input-unsupported"> }
  }
}

// One rule for the model list and the send: an image reaches a model when its
// adapter declares vision. Nothing else delivers images yet, so a model whose
// adapter does not say so takes no image input, whatever its harness could do.
export function modelImageInput(capabilities: AgentCapabilities | undefined): boolean {
  return capabilities?.vision === true
}

function dimensions(bytes: Buffer, mimeType: ImageUpload["mimeType"]): { width: number; height: number } | undefined {
  if (mimeType === "image/png") {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return undefined
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0 || offset + 2 > bytes.length) return undefined
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7]!) return undefined
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) }
    }
    offset += length
  }
  return undefined
}

export function prepareSessionAttachments(uploads: ImageUpload[] | undefined, capabilities: AgentCapabilities | undefined, model: string): AgentVisualContext[] {
  if (!uploads?.length) return []
  if (!modelImageInput(capabilities)) throw new SessionAttachmentError("image-input-unsupported", { model, imageCount: uploads.length })
  if (uploads.length > maximumSessionAttachments) throw new SessionAttachmentError("invalid-image")
  return uploads.map((upload, attachmentIndex) => {
    const size = canonicalBase64DecodedByteLength(upload.data)
    if (size === undefined || size < 1 || size > maximumImageUploadBytes) throw new SessionAttachmentError("invalid-image")
    const bytes = Buffer.from(upload.data, "base64")
    const shape = dimensions(bytes, upload.mimeType)
    if (bytes.length !== size || bytes.toString("base64") !== upload.data || !shape
      || shape.width !== upload.width || shape.height !== upload.height
      || shape.width < 1 || shape.height < 1
      || shape.width > maximumImageUploadDimension || shape.height > maximumImageUploadDimension) {
      throw new SessionAttachmentError("invalid-image")
    }
    return { attachmentIndex, mimeType: upload.mimeType, bytes }
  })
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"))
}

function firstLines(content: string): string {
  return content.split(/\r?\n/u).slice(0, 40).join("\n")
}

export async function prepareSessionAttachmentText(
  attachments: SessionAttachment[] | undefined,
  workspacePath: string | undefined,
): Promise<string> {
  const nonImages = attachments?.filter((attachment) => "kind" in attachment) ?? []
  if (nonImages.length === 0) return ""
  if (!workspacePath) throw new SessionAttachmentError("invalid-workspace-file")
  const root = await realpath(workspacePath)
  const entries: string[] = []
  for (const attachment of nonImages) {
    if (attachment.kind === "workspace-file") {
      const target = await realpath(resolve(root, attachment.path)).catch(() => "")
      if (!target || !inside(root, target)) throw new SessionAttachmentError("invalid-workspace-file")
      const info = await stat(target)
      if (!info.isFile() || info.size > maximumTextAttachmentBytes) throw new SessionAttachmentError("invalid-workspace-file")
      entries.push(`Attached worktree file: ${attachment.path}. Read it from the worktree when needed.`)
      continue
    }
    const bytes = Buffer.byteLength(attachment.content, "utf8")
    if (bytes < 1 || bytes > maximumTextAttachmentBytes) throw new SessionAttachmentError("invalid-text")
    const directory = resolve(root, ".domovoi", "attachments")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const safeName = basename(attachment.name).replace(/[^a-zA-Z0-9._-]/gu, "-") || "attachment.txt"
    const relativePath = `.domovoi/attachments/${randomUUID()}-${safeName}`
    await writeFile(resolve(root, relativePath), attachment.content, { encoding: "utf8", mode: 0o600, flag: "wx" })
    entries.push(`Attached text file: ${relativePath}. First 40 lines:\n\n${firstLines(attachment.content)}\n\nRead the file for the complete content when needed.`)
  }
  return entries.join("\n\n")
}
