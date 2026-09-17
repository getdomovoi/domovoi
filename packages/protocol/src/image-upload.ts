import { z } from "zod"
import { canonicalBase64DecodedByteLength } from "./identifiers.js"
import { utf16MaxLength } from "./validation.js"

export const maximumImageUploadBytes = 1_500_000
export const maximumImageUploadDimension = 2048
export const maximumSessionAttachments = 2

export const imageUploadSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive().max(maximumImageUploadDimension),
  height: z.number().int().positive().max(maximumImageUploadDimension),
  data: z.string().min(4).check(utf16MaxLength(2_000_000)).refine((value) => {
    const decodedBytes = canonicalBase64DecodedByteLength(value)
    return decodedBytes !== undefined && decodedBytes <= maximumImageUploadBytes
  }, { message: "Visual context data must be canonical bounded Base64" }),
}).strict()

export const sessionAttachmentRefusalSchema = z.object({
  kind: z.literal("session-attachment-refused"),
  reason: z.enum(["image-input-unsupported", "invalid-image"]),
}).strict()

export type ImageUpload = z.infer<typeof imageUploadSchema>
export type SessionAttachmentRefusal = z.infer<typeof sessionAttachmentRefusalSchema>
