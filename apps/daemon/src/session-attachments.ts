import {
  canonicalBase64DecodedByteLength, maximumImageUploadBytes, maximumImageUploadDimension,
  maximumSessionAttachments, type ImageUpload, type SessionAttachmentRefusal,
} from "@getdomovoi/protocol"
import type { AgentCapabilities, AgentVisualContext } from "./agents.js"

export class SessionAttachmentError extends Error {
  readonly refusal: SessionAttachmentRefusal
  constructor(reason: SessionAttachmentRefusal["reason"]) {
    super(reason === "image-input-unsupported"
      ? "This adapter cannot accept images. No part of the send was delivered."
      : "An attachment is not a bounded PNG or JPEG matching its declared dimensions.")
    this.refusal = { kind: "session-attachment-refused", reason }
  }
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

export function prepareSessionAttachments(uploads: ImageUpload[] | undefined, capabilities: AgentCapabilities | undefined): AgentVisualContext[] {
  if (!uploads?.length) return []
  if (capabilities?.vision !== true) throw new SessionAttachmentError("image-input-unsupported")
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
