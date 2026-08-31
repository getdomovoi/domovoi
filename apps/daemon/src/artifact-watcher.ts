import { watch } from "node:fs"
import { lstat, opendir, readFile, realpath } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve } from "node:path"

import { maximumPreviewSourceBytes } from "@getdomovoi/protocol"

export type ArtifactFileChange = {
  path: string
  title: string
  type: "plan" | "preview"
  mimeType: "text/markdown" | "text/html"
  content?: string
  variant?: { id: string; groupId: string; label: string; order: number }
}

export type ArtifactWatchSubscription = { close(): void }
export type ArtifactWatchFactory = (
  root: string,
  onEvent: (path?: string) => void,
  onError: (error: unknown) => void,
) => ArtifactWatchSubscription

export type ArtifactWatcherOptions = {
  root: string
  onChange: (change: ArtifactFileChange) => void
  onError?: (error: unknown) => void
  watchFactory?: ArtifactWatchFactory
  maximumDepth?: number
  maximumEntries?: number
  maximumFileBytes?: number
  debounceMs?: number
  openDirectory?: typeof opendir
}

export type ArtifactWatcherHandle = {
  start(): Promise<void>
  stop(): void
}

export type SessionArtifactWatcherFactory = (options: ArtifactWatcherOptions) => ArtifactWatcherHandle

type ArtifactFile = ArtifactFileChange & { fingerprint: string }
type ArtifactScan = { files: ArtifactFile[]; truncated: boolean }

export const maximumArtifactFileBytes = maximumPreviewSourceBytes
const artifactName = /(?:^|[-_.])(plan|preview|design|wireframe|mockup|variant|prototype|roadmap)(?:[-_.]|$)/i
const artifactDirectories = new Set(["artifacts", "previews", "designs", "plans", "plan-preview", "design-studio"])
const ignoredDirectories = new Set([".git", "node_modules", ".pnpm", "coverage"])

const defaultWatchFactory: ArtifactWatchFactory = (root, onEvent, onError) => {
  const watcher = watch(root, { recursive: true }, (_event, path) => {
    onEvent(path === null ? undefined : path.toString())
  })
  watcher.on("error", onError)
  return watcher
}

export class ArtifactWatcher {
  readonly #root: string
  readonly #onChange: (change: ArtifactFileChange) => void
  readonly #onError: (error: unknown) => void
  readonly #watchFactory: ArtifactWatchFactory
  readonly #maximumDepth: number
  readonly #maximumEntries: number
  readonly #maximumFileBytes: number
  readonly #debounceMs: number
  readonly #openDirectory: typeof opendir
  #known = new Map<string, string>()
  #subscription: ArtifactWatchSubscription | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #tail: Promise<void> = Promise.resolve()
  #running = false
  #generation = 0

  constructor(options: ArtifactWatcherOptions) {
    this.#root = resolve(options.root)
    this.#onChange = options.onChange
    this.#onError = options.onError ?? (() => {})
    this.#watchFactory = options.watchFactory ?? defaultWatchFactory
    this.#maximumDepth = Math.max(0, options.maximumDepth ?? 12)
    this.#maximumEntries = Math.max(1, options.maximumEntries ?? 20_000)
    this.#maximumFileBytes = Math.max(1, options.maximumFileBytes ?? maximumArtifactFileBytes)
    this.#debounceMs = Math.max(0, options.debounceMs ?? 40)
    this.#openDirectory = options.openDirectory ?? opendir
  }

  async start(): Promise<void> {
    if (this.#running) return
    const generation = ++this.#generation
    const baseline = await this.#scan()
    if (generation !== this.#generation) return
    if (baseline.truncated) throw new Error("Artifact watcher baseline exceeded its entry limit")
    this.#known = new Map(baseline.files.map((file) => [file.path, file.fingerprint]))
    this.#running = true
    try {
      this.#subscription = this.#watchFactory(
        this.#root,
        () => this.#schedule(),
        (error) => this.#onError(error),
      )
      await this.rescan()
    } catch (error) {
      if (generation !== this.#generation) return
      this.stop()
      throw error
    }
  }

  rescan(): Promise<void> {
    if (!this.#running) return Promise.resolve()
    const task = this.#tail.then(async () => {
      if (!this.#running) return
      const scan = await this.#scan()
      if (!this.#running) return
      if (scan.truncated) {
        this.#onError(new Error("Artifact watcher scan exceeded its entry limit"))
        return
      }
      const next = new Map(scan.files.map((file) => [file.path, file.fingerprint]))
      for (const file of scan.files) {
        if (this.#known.get(file.path) === file.fingerprint) continue
        const { fingerprint, ...change } = file
        void fingerprint
        this.#onChange(change)
      }
      this.#known = next
    })
    this.#tail = task.catch((error: unknown) => this.#onError(error))
    return task
  }

  stop(): void {
    this.#generation += 1
    if (!this.#running && !this.#subscription) return
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#subscription?.close()
    this.#subscription = undefined
    this.#known.clear()
  }

  #schedule(): void {
    if (!this.#running) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.rescan()
    }, this.#debounceMs)
  }

  #scan(): Promise<ArtifactScan> {
    return scanArtifactFiles(this.#root, {
      maximumDepth: this.#maximumDepth,
      maximumEntries: this.#maximumEntries,
      maximumFileBytes: this.#maximumFileBytes,
    }, this.#openDirectory)
  }
}

async function scanArtifactFiles(
  root: string,
  limits: { maximumDepth: number; maximumEntries: number; maximumFileBytes: number },
  openDirectory: typeof opendir,
): Promise<ArtifactScan> {
  const realRoot = await realpath(root)
  const files: ArtifactFile[] = []
  let entriesSeen = 0
  let truncated = false

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (truncated) return
    let handle: Awaited<ReturnType<typeof opendir>>
    try {
      handle = await openDirectory(directory)
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      if (depth > 0 && (code === "ENOENT" || code === "EACCES")) return
      throw error
    }
    const entries = []
    for await (const entry of handle) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > limits.maximumEntries) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < limits.maximumDepth && !ignoredDirectories.has(entry.name)) {
          await visit(path, depth + 1)
        }
        continue
      }
      if (!entry.isFile()) continue
      const pathFromRoot = normalizeRelativePath(relative(realRoot, path))
      const descriptor = artifactDescriptor(pathFromRoot)
      if (!descriptor) continue
      const candidate = await inspectArtifactFile(realRoot, path, pathFromRoot, descriptor, limits.maximumFileBytes)
      if (candidate) files.push(candidate)
    }
  }

  await visit(realRoot, 0)
  return { files: files.sort((left, right) => left.path.localeCompare(right.path)), truncated }
}

function variantOrderFor(variantId: string): number | undefined {
  if (/^[a-z]$/.test(variantId)) return variantId.charCodeAt(0) - 97
  if (!/^(?:0|[1-9][0-9]*)$/.test(variantId)) return undefined
  const order = Number(variantId)
  return Number.isSafeInteger(order) && order >= 0 ? order : undefined
}

function artifactDescriptor(path: string): Pick<ArtifactFileChange, "type" | "mimeType" | "variant"> | undefined {
  const extension = extname(path).toLowerCase()
  if (![".html", ".htm", ".md", ".markdown"].includes(extension)) return undefined
  const segments = path.split("/")
  const stem = basename(path, extension)
  if (!artifactName.test(stem) && !segments.slice(0, -1).some((segment) => artifactDirectories.has(segment.toLowerCase()))) {
    return undefined
  }
  const designStudioIndex = segments.findIndex((segment) => segment.toLowerCase() === "design-studio")
  const variantMatch = designStudioIndex >= 0 ? /^variant[-_.]([a-z0-9][a-z0-9_-]*)$/i.exec(stem) : null
  const variantId = variantMatch?.[1]?.toLowerCase()
  const variantOrder = variantId ? variantOrderFor(variantId) : undefined
  const variant = variantId && variantOrder !== undefined ? {
    id: variantId,
    groupId: segments.slice(0, -1).join("/"),
    label: `Variant ${variantId.length === 1 ? variantId.toUpperCase() : variantId}`,
    order: variantOrder,
  } : undefined
  return extension === ".html" || extension === ".htm"
    ? { type: "preview", mimeType: "text/html", ...(variant ? { variant } : {}) }
    : { type: "plan", mimeType: "text/markdown" }
}

async function inspectArtifactFile(
  realRoot: string,
  lexicalPath: string,
  pathFromRoot: string,
  descriptor: Pick<ArtifactFileChange, "type" | "mimeType" | "variant">,
  maximumFileBytes: number,
): Promise<ArtifactFile | undefined> {
  if (!pathFromRoot || pathFromRoot.startsWith("../") || isAbsolute(pathFromRoot)) return undefined
  try {
    const [metadata, realCandidate] = await Promise.all([lstat(lexicalPath, { bigint: true }), realpath(lexicalPath)])
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > BigInt(maximumFileBytes)) return undefined
    const candidateFromRoot = normalizeRelativePath(relative(realRoot, realCandidate))
    if (!candidateFromRoot || candidateFromRoot.startsWith("../") || isAbsolute(candidateFromRoot)) return undefined
    const content = descriptor.type === "plan" ? await readFile(realCandidate, "utf8") : undefined
    return {
      path: pathFromRoot,
      title: basename(pathFromRoot),
      ...descriptor,
      ...(content === undefined ? {} : { content }),
      fingerprint: `${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`,
    }
  } catch {
    return undefined
  }
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/")
}
