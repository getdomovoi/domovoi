import { z } from "zod"

import { utf16MaxLength } from "./validation.js"

import { annotationAnchorSchema } from "./schema.js"

export const previewBridgeChannelSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)

export const previewParentOriginSchema = z.string().refine((value) => {
  if (value === "null" || value === "domovoi-app://desktop") return true
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
  } catch {
    return false
  }
}, { message: "A preview parent origin must be the Desktop app, a serialized http(s) origin or null" })

export const previewBridgePickerMessageSchema = z.object({
  type: z.literal("domovoi.preview.picker"),
  channel: previewBridgeChannelSchema,
  active: z.boolean(),
})

export const previewBridgeSelectionMessageSchema = z.object({
  type: z.literal("domovoi.preview.selection"),
  channel: previewBridgeChannelSchema,
  artifactId: z.string().min(1),
  anchor: annotationAnchorSchema,
  label: z.string().trim().min(1).check(utf16MaxLength(240)),
})

const previewBridgeAnnotationAnchorSchema = z.object({
  annotationId: z.string().trim().min(1).check(utf16MaxLength(256)),
  anchor: annotationAnchorSchema,
}).strict()

export const previewBridgeResolveAnchorsMessageSchema = z.object({
  type: z.literal("domovoi.preview.resolve-anchors"),
  channel: previewBridgeChannelSchema,
  artifactId: z.string().min(1).check(utf16MaxLength(256)),
  requestId: previewBridgeChannelSchema,
  annotations: z.array(previewBridgeAnnotationAnchorSchema).max(100),
}).strict()

const previewBridgeAnchorResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    annotationId: z.string().trim().min(1).check(utf16MaxLength(256)),
    status: z.literal("resolved"),
    strategy: z.enum(["selector", "text-quote", "bounding-box"]),
  }).strict(),
  z.object({
    annotationId: z.string().trim().min(1).check(utf16MaxLength(256)),
    status: z.literal("unresolved"),
  }).strict(),
])

export const previewBridgeAnchorResolutionsMessageSchema = z.object({
  type: z.literal("domovoi.preview.anchor-resolutions"),
  channel: previewBridgeChannelSchema,
  artifactId: z.string().min(1).check(utf16MaxLength(256)),
  requestId: previewBridgeChannelSchema,
  resolutions: z.array(previewBridgeAnchorResolutionSchema).max(100),
}).strict()

export type PreviewBridgePickerMessage = z.infer<typeof previewBridgePickerMessageSchema>
export type PreviewBridgeSelectionMessage = z.infer<typeof previewBridgeSelectionMessageSchema>
export type PreviewBridgeResolveAnchorsMessage = z.infer<typeof previewBridgeResolveAnchorsMessageSchema>
export type PreviewBridgeAnchorResolutionsMessage = z.infer<typeof previewBridgeAnchorResolutionsMessageSchema>
