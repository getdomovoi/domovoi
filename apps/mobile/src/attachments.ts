import {
  canonicalBase64DecodedByteLength,
  maximumImageUploadBytes,
  maximumImageUploadDimension,
  maximumSessionAttachments,
  sessionAttachmentRefusalSchema,
  type ImageUpload,
} from "@getdomovoi/protocol"

// What the phone holds for one queued image: the wire shape plus what the
// queue shows. The bytes live here until the send and nowhere after.
export type Attachment = ImageUpload & { name: string, bytes: number }

export { maximumSessionAttachments }

// What the picker hands back, in the fields this needs. Read without trusting
// any of them to be present: a library on one platform omits what another
// fills in.
export type PickedImage = {
  fileName?: string | null | undefined
  mimeType?: string | null | undefined
  width: number
  height: number
  base64?: string | null | undefined
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`
const boundLine = `Up to ${megabytes(maximumImageUploadBytes)} and ${maximumImageUploadDimension} px on a side; it is refused rather than resized.`

// The same bounds the daemon holds, applied before the bytes leave the phone,
// so a refusal says which bound and names the file. A phone quietly dropping a
// third photo or a 4 MB one is the shape the pairing card exists to prevent.
// The type is read off the bytes, not off the picker's label: a library
// hands back a JPEG re-encode with the original's name and type on it, and
// the daemon checks the header, so the label would be the wrong thing to
// send. Base64 groups of four characters are three bytes, so the first eight
// bytes are the first twelve characters.
function sniff(base64: string): ImageUpload["mimeType"] | undefined {
  let head: string
  try {
    head = atob(base64.slice(0, 12))
  } catch {
    return undefined
  }
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png"
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) return "image/jpeg"
  return undefined
}

export function attachmentFrom(picked: PickedImage): { ok: true, attachment: Attachment } | { ok: false, reason: string } {
  const name = picked.fileName?.trim() || "This image"
  if (!picked.base64) return { ok: false, reason: `${name} could not be read.` }
  const mimeType = sniff(picked.base64)
  if (!mimeType) return { ok: false, reason: `${name} is not a PNG or JPEG. Only those two are sent.` }
  if (picked.width > maximumImageUploadDimension) {
    return { ok: false, reason: `${name} is ${picked.width} px wide. ${boundLine}` }
  }
  if (picked.height > maximumImageUploadDimension) {
    return { ok: false, reason: `${name} is ${picked.height} px tall. ${boundLine}` }
  }
  const bytes = canonicalBase64DecodedByteLength(picked.base64)
  if (bytes === undefined) return { ok: false, reason: `${name} could not be read.` }
  if (bytes > maximumImageUploadBytes) {
    return { ok: false, reason: `${name} is ${megabytes(bytes)}. ${boundLine}` }
  }
  return {
    ok: true,
    attachment: { name, mimeType, width: picked.width, height: picked.height, data: picked.base64, bytes },
  }
}

// Frame 14's size line: the total, where it goes, that nothing stays on the
// phone, and the bound stated the way the pairing card states its promise.
export function attachmentSummary(queue: readonly Attachment[], machine: string): string | undefined {
  if (queue.length === 0) return undefined
  const total = queue.reduce((sum, item) => sum + item.bytes, 0)
  return `${megabytes(total)} uploads to ${machine} when you send, and is not kept on this phone. `
    + `Images only, up to ${megabytes(maximumImageUploadBytes)} and ${maximumImageUploadDimension} px each. Anything larger is refused rather than resized.`
}

// The daemon's own refusal, read off the error it answered with. Named
// reasons only; anything else is not this refusal and is left to the caller.
export function attachmentRefusalMessage(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined
  const parsed = sessionAttachmentRefusalSchema.safeParse((cause as { data?: unknown }).data)
  if (!parsed.success) return undefined
  return parsed.data.reason === "image-input-unsupported"
    ? "This session's provider cannot take images, so nothing was sent. Remove the images to send the words."
    : "The daemon refused an image as not a bounded PNG or JPEG. Nothing was sent."
}
