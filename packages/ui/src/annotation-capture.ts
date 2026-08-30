import type { Annotation } from "@getdomovoi/protocol"

type Rect = { left: number; top: number; width: number; height: number }

export function annotationCaptureRect(
  frame: Rect,
  bbox: NonNullable<Annotation["anchor"]["bbox"]>,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  if (![frame.left, frame.top, frame.width, frame.height, bbox.x, bbox.y, bbox.width, bbox.height, viewport.width, viewport.height].every(Number.isFinite)) return undefined
  const left = Math.max(0, frame.left, frame.left + bbox.x)
  const top = Math.max(0, frame.top, frame.top + bbox.y)
  const right = Math.min(viewport.width, frame.left + frame.width, frame.left + bbox.x + bbox.width)
  const bottom = Math.min(viewport.height, frame.top + frame.height, frame.top + bbox.y + bbox.height)
  const width = Math.min(2048, Math.floor(right) - Math.ceil(left))
  const height = Math.min(2048, Math.floor(bottom) - Math.ceil(top))
  if (width < 1 || height < 1) return undefined
  return { x: Math.ceil(left), y: Math.ceil(top), width, height }
}

export async function annotationCaptureUpload(
  capture: (rect: { x: number; y: number; width: number; height: number }) => Promise<{
    mimeType: "image/png"
    width: number
    height: number
    data: string
  }>,
  frame: Rect,
  bbox: NonNullable<Annotation["anchor"]["bbox"]>,
  viewport: { width: number; height: number },
  artifactRevision: number,
): Promise<{
  artifactRevision: number
  mimeType: "image/png"
  width: number
  height: number
  data: string
} | undefined> {
  const rect = annotationCaptureRect(frame, bbox, viewport)
  if (!rect) return undefined
  try {
    return { ...await capture(rect), artifactRevision }
  } catch {
    return undefined
  }
}
