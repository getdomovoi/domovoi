import {
  previewBridgeSelectionMessageSchema,
  type PreviewBridgeSelectionMessage,
} from "@getdomovoi/protocol"

export function previewSelectionFor(
  data: unknown,
  channel: string,
  artifactId: string,
): PreviewBridgeSelectionMessage | undefined {
  const result = previewBridgeSelectionMessageSchema.safeParse(data)
  if (!result.success) return undefined
  if (result.data.channel !== channel || result.data.artifactId !== artifactId) return undefined
  return result.data
}
