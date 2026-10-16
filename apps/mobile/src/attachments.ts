import {
  canonicalBase64DecodedByteLength,
  maximumImageUploadBytes,
  maximumImageUploadDimension,
  maximumSessionAttachments,
  sessionAttachmentRefusalSchema,
  type ImageUpload,
  type ProviderModel,
} from "@getdomovoi/protocol"

import { withoutMetadata } from "./image-metadata"

// What the phone holds for one queued image: the wire shape plus what the
// queue shows. The bytes live here until the send and nowhere after.
// resizedFrom is the size the picker handed back, when the phone drew the
// image smaller to fit the bound; the chip says so.
export type Attachment = ImageUpload & {
  name: string
  bytes: number
  resizedFrom?: { width: number, height: number }
}

export { maximumSessionAttachments }

// What the picker hands back, in the fields this needs. Read without trusting
// any of them to be present: a library on one platform omits what another
// fills in.
export type PickedImage = {
  uri?: string | null | undefined
  fileName?: string | null | undefined
  mimeType?: string | null | undefined
  width: number
  height: number
  base64?: string | null | undefined
}

// One request to the device's image encoder: draw the picked file at this
// size and write it in this format. quality is JPEG compression, 0 to 1; a
// PNG is lossless and ignores it. The adapter is image-encoder.ts.
export type ImageEncoding = {
  uri: string
  width: number
  height: number
  format: "jpeg" | "png"
  quality: number
}
export type ImageEncoder = (request: ImageEncoding) => Promise<{ base64: string, width: number, height: number }>

// A 2048 px photo at 0.8 is well under 1.5 MB in practice and shows no
// visible loss at the sizes a model reads.
export const jpegQuality = 0.8

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`
const boundLine = `Up to ${megabytes(maximumImageUploadBytes)} and ${maximumImageUploadDimension} px on a side.`

// The size that fits the dimension bound, long side first, aspect kept.
function fitted(width: number, height: number): { width: number, height: number } {
  const longest = Math.max(width, height)
  if (longest <= maximumImageUploadDimension) return { width, height }
  const scale = maximumImageUploadDimension / longest
  return {
    width: Math.min(maximumImageUploadDimension, Math.max(1, Math.round(width * scale))),
    height: Math.min(maximumImageUploadDimension, Math.max(1, Math.round(height * scale))),
  }
}

function binary(base64: string): string | undefined {
  try {
    return atob(base64)
  } catch {
    return undefined
  }
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\.+$/, "")

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

export type AttachmentRead = { ok: true, attachment: Attachment } | { ok: false, reason: string }

// Q121 A (walk F22): nearly every iPhone photo (4032 x 3024) and Pro Max
// screenshot (1320 x 2868) is over 2048 px, so the phone draws it smaller
// rather than refusing it. An image inside both bounds and carrying no
// metadata is sent byte for byte as picked. Anything else is drawn again by
// the device encoder, at the fitted size, which also writes the pixels
// upright and leaves the camera's metadata behind; the result is then cut
// of any metadata segment the encoder wrote, so what leaves the phone holds
// no location whatever the encoder does. A PNG stays a PNG when it fits the
// byte bound, otherwise it is drawn again as a JPEG. Still over the byte
// bound after that is refused, as before. The daemon's bounds are the same
// ones and still refuse an unresized image from any client.
export async function attachmentFrom(picked: PickedImage, encode: ImageEncoder): Promise<AttachmentRead> {
  const name = picked.fileName?.trim() || "This image"
  if (!picked.base64) return { ok: false, reason: `${name} could not be read.` }
  const mimeType = sniff(picked.base64)
  if (!mimeType) return { ok: false, reason: `${name} is not a PNG or JPEG. Only those two are sent.` }
  const bytes = canonicalBase64DecodedByteLength(picked.base64)
  if (bytes === undefined) return { ok: false, reason: `${name} could not be read.` }

  const target = fitted(picked.width, picked.height)
  const resized = target.width !== picked.width || target.height !== picked.height
  if (!resized && bytes <= maximumImageUploadBytes) {
    const raw = binary(picked.base64)
    if (raw !== undefined && withoutMetadata(raw, mimeType) === raw) {
      return { ok: true, attachment: { name, mimeType, width: picked.width, height: picked.height, data: picked.base64, bytes } }
    }
  }

  const doing = resized ? "resized" : "re-encoded"
  const refused = (why: string): AttachmentRead => ({ ok: false, reason: `${name} could not be ${doing} on this phone (${why}). ${boundLine}` })
  if (!picked.uri) return refused("no file to read")
  // The encoder draws from the file, and iOS's picker hands back the Base64
  // as a JPEG re-encode whatever the file is, so a screenshot's PNG-ness is
  // read off the file's type or name as well as the bytes.
  const sourcePng = mimeType === "image/png" || picked.mimeType === "image/png" || /\.png$/i.test(picked.uri)
  const formats: ImageEncoding["format"][] = sourcePng ? ["png", "jpeg"] : ["jpeg"]
  // The last encoding over the byte bound; every pass through the loop that
  // does not return sets it.
  let over = { bytes, ...target }
  for (const format of formats) {
    let encoded: Awaited<ReturnType<ImageEncoder>>
    try {
      encoded = await encode({ uri: picked.uri, ...target, format, quality: format === "png" ? 1 : jpegQuality })
    } catch (cause) {
      return refused(messageOf(cause))
    }
    if (encoded.width > maximumImageUploadDimension || encoded.height > maximumImageUploadDimension) {
      return refused(`it came back ${encoded.width} x ${encoded.height}`)
    }
    const written = sniff(encoded.base64)
    const raw = written === undefined ? undefined : binary(encoded.base64)
    const clean = written === undefined || raw === undefined ? undefined : withoutMetadata(raw, written)
    if (written === undefined || clean === undefined) return refused("it came back unreadable")
    if (clean.length <= maximumImageUploadBytes) {
      return {
        ok: true,
        attachment: {
          name,
          mimeType: written,
          width: encoded.width,
          height: encoded.height,
          data: btoa(clean),
          bytes: clean.length,
          ...(resized ? { resizedFrom: { width: picked.width, height: picked.height } } : {}),
        },
      }
    }
    over = { bytes: clean.length, width: encoded.width, height: encoded.height }
  }
  return {
    ok: false,
    reason: `${name} is still ${megabytes(over.bytes)} at ${over.width} x ${over.height} after ${resized ? "resizing" : "re-encoding"} on this phone. ${boundLine}`,
  }
}

// The chip's note for an image the phone drew smaller.
export function resizedNote(attachment: Attachment): string | undefined {
  return attachment.resizedFrom ? `resized from ${attachment.resizedFrom.width} x ${attachment.resizedFrom.height}` : undefined
}

// Frame 14's size line: the total, where it goes, that nothing stays on the
// phone, and the bound stated the way the pairing card states its promise.
// Q121 A replaced the design's "Anything larger is refused rather than
// resized" with what the phone now does.
export function attachmentSummary(queue: readonly Attachment[], machine: string): string | undefined {
  if (queue.length === 0) return undefined
  const total = queue.reduce((sum, item) => sum + item.bytes, 0)
  return `${megabytes(total)} uploads to ${machine} when you send, and is not kept on this phone. `
    + `Images only, up to ${megabytes(maximumImageUploadBytes)} and ${maximumImageUploadDimension} px each: `
    + "a larger one is resized on this phone first, and location and other metadata are removed."
}

// Phone v2 frames 13, 13b and 14b: the model the session uses and whether
// its harness reports image input, from runtime.models. Undefined is not
// known (not read yet, not answered, or not reported), which is not no: only
// false locks the image sources and the send.
export type ModelImages = { model: string, imageInput: boolean | undefined }

export function modelImages(
  models: readonly ProviderModel[] | undefined,
  runtime: { provider: string, model: string },
): ModelImages {
  const found = models?.find((candidate) => candidate.provider === runtime.provider && candidate.id === runtime.model)
  return { model: runtime.model, imageInput: found?.imageInput }
}

export function modelImagesLine(imageInput: boolean | undefined): string {
  if (imageInput === true) return "takes image input, as its harness reports"
  if (imageInput === false) return "takes no image input, as its harness reports"
  return "image input not known"
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
