import { z } from "zod"
import { canonicalBase64DecodedByteLength } from "./identifiers.js"
import { utf16MaxLength } from "./validation.js"

export const maximumImageUploadBytes = 1_500_000
export const maximumImageUploadDimension = 2048
export const maximumSessionAttachments = 2
export const maximumTextAttachmentBytes = 262_144
export const maximumTextAttachmentCharacters = 262_144

export const imageUploadSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive().max(maximumImageUploadDimension),
  height: z.number().int().positive().max(maximumImageUploadDimension),
  data: z.string().min(4).check(utf16MaxLength(2_000_000)).refine((value) => {
    const decodedBytes = canonicalBase64DecodedByteLength(value)
    return decodedBytes !== undefined && decodedBytes <= maximumImageUploadBytes
  }, { message: "Visual context data must be canonical bounded Base64" }),
}).strict()

export const textAttachmentSchema = z.object({
  kind: z.literal("text"),
  name: z.string().trim().min(1).check(utf16MaxLength(255)),
  mimeType: z.literal("text/plain"),
  content: z.string().min(1).check(utf16MaxLength(maximumTextAttachmentCharacters)).refine(
    (value) => new TextEncoder().encode(value).byteLength <= maximumTextAttachmentBytes,
    { message: "Text attachment exceeds the byte limit" },
  ),
}).strict()

export const workspaceFileAttachmentSchema = z.object({
  kind: z.literal("workspace-file"),
  path: z.string().min(1).check(utf16MaxLength(1024)).refine(
    (value) => {
      if (value.startsWith("-") || value.includes("\0")) return false
      if (value.startsWith("/") || value.startsWith("\\")) return false
      if (/^[a-zA-Z]:[\\/]/.test(value)) return false
      return value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== ".." && segment !== ".")
    },
    { message: "File path must stay inside the session worktree" },
  ),
}).strict()

export const sessionAttachmentSchema = z.union([
  imageUploadSchema,
  textAttachmentSchema,
  workspaceFileAttachmentSchema,
])

export const sessionAttachmentRefusalSchema = z.union([
  // The selected model takes no image input. The daemon names the model and
  // the count so the composer can say "2 images cannot go to <model>"; the
  // code is the one the attach sheet shows beside the lock. The three fields
  // are absent from an older daemon.
  z.object({
    kind: z.literal("session-attachment-refused"),
    reason: z.literal("image-input-unsupported"),
    code: z.literal("attach.image.model_no_input").optional(),
    model: z.string().min(1).check(utf16MaxLength(256)).optional(),
    imageCount: z.number().int().positive().max(maximumSessionAttachments).optional(),
  }).strict(),
  z.object({
    kind: z.literal("session-attachment-refused"),
    reason: z.enum(["invalid-image", "invalid-text", "invalid-workspace-file"]),
  }).strict(),
])

export type ImageUpload = z.infer<typeof imageUploadSchema>
export type TextAttachment = z.infer<typeof textAttachmentSchema>
export type WorkspaceFileAttachment = z.infer<typeof workspaceFileAttachmentSchema>
export type SessionAttachment = z.infer<typeof sessionAttachmentSchema>
export type SessionAttachmentRefusal = z.infer<typeof sessionAttachmentRefusalSchema>
