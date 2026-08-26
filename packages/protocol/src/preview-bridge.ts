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

export type PreviewBridgePickerMessage = z.infer<typeof previewBridgePickerMessageSchema>
export type PreviewBridgeSelectionMessage = z.infer<typeof previewBridgeSelectionMessageSchema>
