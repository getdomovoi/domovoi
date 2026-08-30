import { z } from "zod"

import { annotationAnchorSchema } from "./schema.js"

export const previewBridgeChannelSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)

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
  label: z.string().trim().min(1).max(240),
})

const previewBridgeAnnotationAnchorValueSchema = z.object({
  cssSelector: z.string().min(1).max(1_000).optional(),
  textQuote: z.string().min(1).max(2_000).optional(),
  bbox: z.object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }).strict().optional(),
}).strict().refine(
  (anchor) => Boolean(anchor.cssSelector || anchor.textQuote || anchor.bbox),
  { message: "A preview annotation anchor requires a selector, quote, or bounding box" },
)

const previewBridgeAnnotationAnchorSchema = z.object({
  annotationId: z.string().trim().min(1).max(256),
  anchor: previewBridgeAnnotationAnchorValueSchema,
}).strict()

export const previewBridgeResolveAnchorsMessageSchema = z.object({
  type: z.literal("domovoi.preview.resolve-anchors"),
  channel: previewBridgeChannelSchema,
  artifactId: z.string().min(1).max(256),
  requestId: previewBridgeChannelSchema,
  annotations: z.array(previewBridgeAnnotationAnchorSchema).max(100),
}).strict()

const previewBridgeAnchorResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    annotationId: z.string().trim().min(1).max(256),
    status: z.literal("resolved"),
    strategy: z.enum(["selector", "text-quote", "bounding-box"]),
  }).strict(),
  z.object({
    annotationId: z.string().trim().min(1).max(256),
    status: z.literal("unresolved"),
  }).strict(),
])

export const previewBridgeAnchorResolutionsMessageSchema = z.object({
  type: z.literal("domovoi.preview.anchor-resolutions"),
  channel: previewBridgeChannelSchema,
  artifactId: z.string().min(1).max(256),
  requestId: previewBridgeChannelSchema,
  resolutions: z.array(previewBridgeAnchorResolutionSchema).max(100),
}).strict()

export type PreviewBridgePickerMessage = z.infer<typeof previewBridgePickerMessageSchema>
export type PreviewBridgeSelectionMessage = z.infer<typeof previewBridgeSelectionMessageSchema>
export type PreviewBridgeResolveAnchorsMessage = z.infer<typeof previewBridgeResolveAnchorsMessageSchema>
export type PreviewBridgeAnchorResolutionsMessage = z.infer<typeof previewBridgeAnchorResolutionsMessageSchema>
