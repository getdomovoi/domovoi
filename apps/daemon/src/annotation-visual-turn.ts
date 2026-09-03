import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { agentPromptWithAnnotations } from "./annotation-context.js"
import type { AgentCapabilities, AgentVisualContext } from "./agents.js"
import type { AnnotationVisualContextReader } from "./annotation-visual-context.js"

const maximumImagesPerTurn = 4
const maximumVisualBytesPerTurn = 4_000_000

export type AnnotationVisualDelivery = "image-attached" | "provider-text-fallback" | "crop-unavailable"

export type PreparedAnnotationVisuals = {
  deliveries: Map<string, AnnotationVisualDelivery>
  visualContexts: AgentVisualContext[]
}

export async function prepareAnnotationVisuals(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  capabilities: AgentCapabilities | undefined,
  reader: AnnotationVisualContextReader,
): Promise<PreparedAnnotationVisuals> {
  const deliveries = new Map<string, AnnotationVisualDelivery>()
  const visualContexts: AgentVisualContext[] = []
  let totalBytes = 0
  const annotations = snapshot.annotations
    .filter((annotation) => annotation.sessionId === sessionId && annotation.status === "open")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  for (const annotation of annotations) {
    const crop = annotation.visualContext
    if (!crop || crop.status !== "available") continue
    if (capabilities?.vision !== true) {
      deliveries.set(annotation.id, "provider-text-fallback")
      continue
    }
    if (
      visualContexts.length >= maximumImagesPerTurn
      || totalBytes + crop.byteLength > maximumVisualBytesPerTurn
    ) {
      deliveries.set(annotation.id, "crop-unavailable")
      continue
    }
    try {
      const bytes = await reader.read(crop.ref, crop.mimeType)
      if (bytes.byteLength !== crop.byteLength) throw new Error("Crop byte length changed")
      visualContexts.push({ annotationId: annotation.id, mimeType: crop.mimeType, bytes })
      totalBytes += bytes.byteLength
      deliveries.set(annotation.id, "image-attached")
    } catch {
      deliveries.set(annotation.id, "crop-unavailable")
    }
  }
  return { deliveries, visualContexts }
}

export async function prepareAnnotationTurn(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  userPrompt: string,
  capabilities: AgentCapabilities | undefined,
  reader: AnnotationVisualContextReader,
): Promise<{ prompt: string; visualContexts: AgentVisualContext[] }> {
  const prepared = await prepareAnnotationVisuals(
    snapshot,
    sessionId,
    capabilities,
    reader,
  )
  return {
    prompt: agentPromptWithAnnotations(snapshot, sessionId, userPrompt, prepared.deliveries),
    visualContexts: prepared.visualContexts,
  }
}
