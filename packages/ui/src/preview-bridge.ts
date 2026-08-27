import {
  previewBridgeSelectionMessageSchema,
  type PreviewBridgeSelectionMessage,
} from "@getdomovoi/protocol"

export function createPreviewBridgeChannel(
  randomUuid: (() => string) | null = globalThis.crypto?.randomUUID
    ? () => globalThis.crypto.randomUUID()
    : null,
  random: () => number = Math.random,
): string {
  const token = randomUuid
    ? randomUuid().replaceAll("-", "")
    : Array.from({ length: 32 }, () => Math.floor(random() * 36).toString(36)).join("")
  return `preview_${token}`
}

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
