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

// wake() is for a polled watch: reschedule the next poll at the current delay,
// used when the session turns active again. A native watch has nothing to wake.
export type ArtifactWatchSubscription = { close(): void; wake?(): void }
// A polled watch calls poll.tick() on its own schedule, waits for that scan,
// and asks poll.delay() for the wait before the next one.
export type ArtifactPoll = { delay(): number; tick(): Promise<void> }
export type ArtifactWatchFactory = (
  root: string,
  onEvent: (path?: string) => void,
  onError: (error: unknown) => void,
  poll?: ArtifactPoll,
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
  // Whether the session has a turn starting or running. A busy session is
  // polled every 2 s however many scans came back unchanged.
  setBusy?(busy: boolean): void
}

export type SessionArtifactWatcherFactory = (options: ArtifactWatcherOptions) => ArtifactWatcherHandle

type ArtifactFile = Omit<ArtifactFileChange, "content"> & {
  fingerprint: string
  readContent?: () => Promise<string>
}
type ArtifactScan = { files: ArtifactFile[]; truncated: boolean }

export const maximumArtifactFileBytes = maximumPreviewSourceBytes
const artifactName = /(?:^|[-_.])(plan|preview|design|wireframe|mockup|variant|prototype|roadmap)(?:[-_.]|$)/i
const artifactDirectories = new Set(["artifacts", "previews", "designs", "plans", "plan-preview", "design-studio"])
const ignoredDirectories = new Set([
  ".git", "node_modules", ".pnpm", "coverage",
  "dist", "build", "out", "target", ".next", ".venv", "venv", "__pycache__", ".turbo", ".cache",
])

const nativeRecursiveWatch: ArtifactWatchFactory = (root, onEvent, onError) => {
  const watcher = watch(root, { recursive: true }, (_event, path) => {
    onEvent(path === null ? undefined : path.toString())
  })
  watcher.on("error", onError)
  return watcher
}

export const artifactPollIntervalMs = 2_000
// fetzy, 2026-09-23: an idle session backs off. After this many scans in a
// row find nothing new, and while no turn runs, it is scanned every 10 s. A
// watch event, a turn starting or running, or a scan that finds a new or
// changed artifact puts it back on 2 s.
export const artifactIdlePollIntervalMs = 10_000
export const artifactIdleAfterScans = 3

// Node emulates a recursive watch outside macOS and Windows: it walks the
// whole tree synchronously and holds one inotify watch per file, including
// node_modules, with no way to skip it. There the bounded asynchronous scan is
// polled instead; its fingerprints already decide whether anything changed.
const pollingWatch: ArtifactWatchFactory = (_root, onEvent, _onError, poll) => {
  const delay = () => poll?.delay() ?? artifactPollIntervalMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let ticking = false
  let closed = false
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void tick(), delay())
    timer.unref?.()
  }
  const tick = async () => {
    timer = undefined
    ticking = true
    try {
      if (poll) await poll.tick().catch(() => undefined)
      else onEvent()
    } finally {
      ticking = false
    }
    if (!closed) arm()
  }
  arm()
  return {
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
    wake: () => {
      if (closed || ticking) return
      arm()
    },
  }
}

export function watchFactoryFor(platform: NodeJS.Platform): ArtifactWatchFactory {
  return platform === "darwin" || platform === "win32" ? nativeRecursiveWatch : pollingWatch
}

const defaultWatchFactory = watchFactoryFor(process.platform)

function insideIgnoredDirectory(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => ignoredDirectories.has(segment))
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
  #scanning: Promise<void> | undefined
  #unchangedScans = 0
  #busy = false
  #waiting: Promise<void> | undefined
  #failure: string | undefined
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
        (path) => {
          // The scan never enters these directories, so nothing that changes
          // in them can change an artifact; a build or test run there should
          // not cost a walk of the worktree.
          if (path !== undefined && insideIgnoredDirectory(path)) return
          this.#active()
          this.#schedule()
        },
        (error) => this.#onError(error),
        { delay: () => this.#pollDelay(), tick: () => this.rescan() },
      )
      await this.rescan()
    } catch (error) {
      if (generation !== this.#generation) return
      this.stop()
      throw error
    }
  }

  // At most one walk runs and at most one waits behind it. A poll tick or an
  // event while a walk is in flight joins the waiting one, so a scan slower
  // than the poll interval cannot build a queue.
  rescan(): Promise<void> {
    if (!this.#running) return Promise.resolve()
    if (this.#waiting) return this.#waiting
    const current = this.#scanning
    if (current === undefined) return this.#startScan()
    const waiting = current.catch(() => undefined).then(() => {
      if (this.#waiting === waiting) this.#waiting = undefined
      return this.#startScan()
    })
    this.#waiting = waiting
    return waiting
  }

  #startScan(): Promise<void> {
    if (!this.#running) return Promise.resolve()
    const task = this.#scanOnce()
    this.#scanning = task
    const settle = () => { if (this.#scanning === task) this.#scanning = undefined }
    task.then(settle, (error: unknown) => {
      settle()
      this.#unchangedScans += 1
      this.#fail(error instanceof Error ? error.message : String(error), error)
    })
    return task
  }

  async #scanOnce(): Promise<void> {
    const scan = await this.#scan()
    if (!this.#running) return
    if (scan.truncated) {
      this.#unchangedScans += 1
      this.#fail("truncated", new Error("Artifact watcher scan exceeded its entry limit"))
      return
    }
    const next = new Map(scan.files.map((file) => [file.path, file.fingerprint]))
    let changed = false
    for (const file of scan.files) {
      if (this.#known.get(file.path) === file.fingerprint) continue
      changed = true
      const { fingerprint, readContent, ...rest } = file
      void fingerprint
      const content = readContent === undefined ? undefined : await readContent()
      this.#onChange({ ...rest, ...(content === undefined ? {} : { content }) })
    }
    this.#known = next
    this.#failure = undefined
    if (changed) this.#unchangedScans = 0
    else this.#unchangedScans += 1
  }

  // A failure that repeats on every poll is reported once, and again only
  // after a scan has succeeded in between.
  setBusy(busy: boolean): void {
    // #active reads whether the session was idle, so it runs before the flag
    // that makes every session read as busy.
    if (busy && !this.#busy) this.#active()
    this.#busy = busy
  }

  #pollDelay(): number {
    return this.#busy || this.#unchangedScans < artifactIdleAfterScans
      ? artifactPollIntervalMs
      : artifactIdlePollIntervalMs
  }

  // Activity puts an idle session back on the fast poll now, not after the
  // 10 s wait already scheduled.
  #active(): void {
    const wasIdle = this.#pollDelay() === artifactIdlePollIntervalMs
    this.#unchangedScans = 0
    if (wasIdle) this.#subscription?.wake?.()
  }

  #fail(key: string, error: unknown): void {
    if (this.#failure === key) return
    this.#failure = key
    this.#onError(error)
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
    this.#failure = undefined
    this.#unchangedScans = 0
    this.#busy = false
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
    return {
      path: pathFromRoot,
      title: basename(pathFromRoot),
      ...descriptor,
      ...(descriptor.type === "plan" ? { readContent: () => readFile(realCandidate, "utf8") } : {}),
      fingerprint: `${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`,
    }
  } catch {
    return undefined
  }
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/")
}
