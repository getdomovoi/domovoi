type Rect = { left: number; top: number; width: number; height: number }

export function reservePreviewThumbnail(reserved: Set<string>, artifactId: string, revision: number): boolean {
  const key = `${artifactId}:${revision}`
  if (reserved.has(key)) return false
  if (reserved.size >= 24) {
    const oldestKey = reserved.values().next().value as string | undefined
    if (oldestKey) reserved.delete(oldestKey)
  }
  reserved.add(key)
  return true
}

export function releasePreviewThumbnail(reserved: Set<string>, artifactId: string, revision: number): void {
  reserved.delete(`${artifactId}:${revision}`)
}

export function previewThumbnailRect(
  frame: Rect,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  if (![frame.left, frame.top, frame.width, frame.height, viewport.width, viewport.height].every(Number.isFinite)) return undefined
  const x = Math.max(0, Math.ceil(frame.left))
  const y = Math.max(0, Math.ceil(frame.top))
  const width = Math.min(320, Math.floor(frame.width), Math.floor(viewport.width) - x)
  const height = Math.min(180, Math.floor(frame.height), Math.floor(viewport.height) - y)
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

export function previewThumbnailObjectUrl(
  capture: { mimeType: "image/png"; width: number; height: number; data: string },
): string | undefined {
  if (capture.width < 1 || capture.height < 1 || capture.width > 320 || capture.height > 180) return undefined
  try {
    const binary = atob(capture.data)
    if (binary.length < 8 || binary.length > 400_000) return undefined
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return undefined
    return URL.createObjectURL(new Blob([bytes], { type: capture.mimeType }))
  } catch {
    return undefined
  }
}
