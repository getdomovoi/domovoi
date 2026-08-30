import {
  previewBridgeAnchorResolutionsMessageSchema,
  previewBridgeSelectionMessageSchema,
  type Annotation,
  type PreviewBridgeAnchorResolutionsMessage,
  type PreviewBridgeResolveAnchorsMessage,
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

export function previewResolveAnchorMessages(
  channel: string,
  artifactId: string,
  annotations: Array<{ annotationId: string; anchor: Annotation["anchor"] }>,
  createRequestId: () => string = () => createPreviewBridgeChannel(),
): PreviewBridgeResolveAnchorsMessage[] {
  const messages: PreviewBridgeResolveAnchorsMessage[] = []
  for (let offset = 0; offset < annotations.length; offset += 100) {
    messages.push({
      type: "domovoi.preview.resolve-anchors",
      channel,
      artifactId,
      requestId: createRequestId(),
      annotations: annotations.slice(offset, offset + 100),
    })
  }
  return messages
}

export function anchorResolutionsFor(
  data: unknown,
  channel: string,
  artifactId: string,
  requestId: string,
  expectedAnnotationIds: readonly string[],
): PreviewBridgeAnchorResolutionsMessage | undefined {
  const result = previewBridgeAnchorResolutionsMessageSchema.safeParse(data)
  if (!result.success) return undefined
  if (
    result.data.channel !== channel
    || result.data.artifactId !== artifactId
    || result.data.requestId !== requestId
  ) return undefined
  const remaining = new Set(expectedAnnotationIds)
  if (remaining.size !== expectedAnnotationIds.length || result.data.resolutions.length !== remaining.size) {
    return undefined
  }
  for (const resolution of result.data.resolutions) {
    if (!remaining.delete(resolution.annotationId)) return undefined
  }
  if (remaining.size > 0) return undefined
  return result.data
}

export function previewReadyFor(data: unknown, channel: string, artifactId: string): boolean {
  if (!data || typeof data !== "object") return false
  const message = data as Record<string, unknown>
  return message.type === "domovoi.preview.ready"
    && message.channel === channel
    && message.artifactId === artifactId
}

export type PreviewAnchorResolution = "selector" | "text-quote" | "bounding-box" | "unresolved"

export function mergeAnchorResolutionBatch(
  current: ReadonlyMap<string, PreviewAnchorResolution>,
  resolutions: PreviewBridgeAnchorResolutionsMessage["resolutions"],
): ReadonlyMap<string, PreviewAnchorResolution> {
  const result = new Map(current)
  for (const resolution of resolutions) {
    result.set(
      resolution.annotationId,
      resolution.status === "resolved" ? resolution.strategy : "unresolved",
    )
  }
  return result
}
