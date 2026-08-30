type Rect = { left: number; top: number; width: number; height: number }

type ThumbnailEntry = { status: "pending" } | { status: "ready"; url: string }

export class PreviewThumbnailLifecycle {
  readonly #entries = new Map<string, ThumbnailEntry>()
  readonly #maximumEntries: number
  readonly #revoke: (url: string) => void

  constructor(maximumEntries = 24, revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)) {
    this.#maximumEntries = Math.max(1, maximumEntries)
    this.#revoke = revoke
  }

  get size(): number {
    return this.#entries.size
  }

  reserve(artifactId: string, revision: number): boolean {
    const key = `${artifactId}:${revision}`
    if (this.#entries.has(key)) return false
    while (this.#entries.size >= this.#maximumEntries) this.#evictOldest()
    this.#entries.set(key, { status: "pending" })
    return true
  }

  resolve(artifactId: string, revision: number, url: string): boolean {
    const key = `${artifactId}:${revision}`
    const entry = this.#entries.get(key)
    if (entry?.status !== "pending") {
      this.#revoke(url)
      return false
    }
    this.#entries.set(key, { status: "ready", url })
    return true
  }

  fail(artifactId: string, revision: number): void {
    const key = `${artifactId}:${revision}`
    if (this.#entries.get(key)?.status === "pending") this.#entries.delete(key)
  }

  readyUrls(): ReadonlyMap<string, string> {
    return new Map(
      [...this.#entries].flatMap(([key, entry]) => entry.status === "ready" ? [[key, entry.url]] : []),
    )
  }

  clear(): void {
    for (const entry of this.#entries.values()) {
      if (entry.status === "ready") this.#revoke(entry.url)
    }
    this.#entries.clear()
  }

  #evictOldest(): void {
    const oldestKey = this.#entries.keys().next().value as string | undefined
    if (!oldestKey) return
    const entry = this.#entries.get(oldestKey)
    this.#entries.delete(oldestKey)
    if (entry?.status === "ready") this.#revoke(entry.url)
  }
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
