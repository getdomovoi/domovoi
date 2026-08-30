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

export function previewResolveAnchorsMessage(
  channel: string,
  artifactId: string,
  annotations: Array<{ annotationId: string; anchor: Annotation["anchor"] }>,
): PreviewBridgeResolveAnchorsMessage {
  return {
    type: "domovoi.preview.resolve-anchors",
    channel,
    artifactId,
    annotations: annotations.slice(0, 100),
  }
}

export function anchorResolutionsFor(
  data: unknown,
  channel: string,
  artifactId: string,
): PreviewBridgeAnchorResolutionsMessage | undefined {
  const result = previewBridgeAnchorResolutionsMessageSchema.safeParse(data)
  if (!result.success) return undefined
  if (result.data.channel !== channel || result.data.artifactId !== artifactId) return undefined
  return result.data
}

export type PreviewAnchorResolution = "selector" | "text-quote" | "bounding-box" | "unresolved"

export function anchorResolutionMapFor(
  annotationIds: readonly string[],
  resolutions: PreviewBridgeAnchorResolutionsMessage["resolutions"],
): ReadonlyMap<string, PreviewAnchorResolution> {
  const result = new Map<string, PreviewAnchorResolution>(
    annotationIds.map((annotationId) => [annotationId, "unresolved"]),
  )
  for (const resolution of resolutions) {
    if (!result.has(resolution.annotationId)) continue
    result.set(
      resolution.annotationId,
      resolution.status === "resolved" ? resolution.strategy : "unresolved",
    )
  }
  return result
}
