import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  maximumWebBundleManifestBytes,
  parseWebBundleManifest,
  protocolVersion,
  webBundleCompatibility,
  webBundleContentType,
  webBundleManifestFileName,
  type WebBundleManifestRefusal,
} from "@getdomovoi/protocol"

// Loads the web app bundle the daemon serves (S3.2, plan section 1.3), once,
// into memory. Later requests are answered by lookup in the returned map and
// never touch the file system, so no request string can reach a path.
//
// The whole bundle is refused when any check fails; there is no partial load.
// The root may be a link the owner configured: it is resolved once with
// realpath. Below it, every directory between the root and a file is checked
// with lstat before the file is opened and again after it is read, and must
// be the same directory both times. The file is opened with O_NOFOLLOW where
// the platform has it (Windows does not) and O_NONBLOCK, so a FIFO swapped in
// cannot hold the open, and the open descriptor must be the regular file
// lstat saw. A link found at any of those checks is refused.
//
// That is narrower than link-free traversal (review F2, Q297). Every call
// re-resolves a pathname from the root; Node has no openat2 or other lookup
// anchored to a checked directory handle, and O_NOFOLLOW covers only the last
// component. A directory swapped for a link and back between two checks is
// not seen, and on Windows a link to the same file passes. On POSIX, with the
// owner and mode checks at trustedOwner and a trusted install location, only
// the daemon's own account or root can make that change, so a race by that
// account is a trusted-account limit, not one this loader defends. That does
// not hold on Windows, where neither is checked, or where an ACL grants
// another account rights the mode bits do not show. Whatever the traversal, every byte kept has the size and
// SHA-256 the parsed manifest lists. Who may change the tree, and the
// access-control-list limit, are stated at trustedOwner below.

// The file-system calls the loader makes, so a test can swap a file between
// two of them.
export type WebAppBundleFileSystem = {
  lstat: (path: string, options: { bigint: true }) => Promise<BigIntStats>
  realpath: (path: string) => Promise<string>
  open: (path: string, flags: number) => Promise<FileHandle>
}

const nodeFileSystem: WebAppBundleFileSystem = { lstat, realpath, open }

export type LoadedWebAppFile = {
  bytes: Buffer
  contentType: string
  sha256: string
  // Strong validator from the manifest digest the bytes were checked against.
  etag: string
  // "hashed": vite's content-hashed assets/ names, cacheable for good.
  // "entry": everything else, revalidated on every load.
  cacheClass: "entry" | "hashed"
}

// Vite (8.3, apps/web/vite.config.ts sets no file-name pattern) writes
// assets/<name>-<hash>.<ext> with an eight-character base64url hash, which
// can itself contain "-" or "_" (index-B0V_-a_P.js). A file is cached for
// good only under assets/ and with that shape, and only when the hash holds
// an uppercase letter or a digit: a stable name such as app-settings.js has
// the shape too, and a stale copy of a stable name is the failure this
// avoids. A real hash with neither is merely revalidated, the safe side.
const contentHashedName = /-(?=[A-Za-z0-9_-]{0,7}[A-Z0-9])[A-Za-z0-9_-]{8}\.[a-z0-9]+(?![\s\S])/

function webAppCacheClass(listed: string): "entry" | "hashed" {
  if (!listed.startsWith("assets/")) return "entry"
  const name = listed.slice(listed.lastIndexOf("/") + 1)
  return contentHashedName.test(name) ? "hashed" : "entry"
}

export type WebAppBundleInvalidReason =
  | WebBundleManifestRefusal
  | "root-unreadable"
  | "root-not-directory"
  | "root-in-profile"
  | "root-writable"
  | "owner-untrusted"
  | "ancestor-owner-untrusted"
  | "ancestor-writable"
  | "manifest-too-large"
  | "manifest-not-json"
  | "symbolic-link"
  | "hard-link"
  | "not-a-directory"
  | "not-regular-file"
  | "file-missing"
  | "file-unreadable"
  | "file-changed"
  | "file-writable"
  | "directory-writable"
  | "size-mismatch"
  | "digest-mismatch"
  | "duplicate-file"

// files is read-only by contract, not at runtime: the result and each entry
// are shallowly frozen, but the Map and each Buffer can still be changed by
// code in this process. Callers look up and send; none may write. Nothing on
// disk can change them after the load.
//
// path, when set, is relative to the root as the manifest writes it, so a
// report can name the file without a home directory in it. The exception is
// a directory above the root (the ancestor reasons, and a link or unreadable
// entry found there), named by its absolute path.
export type WebAppBundleLoad =
  | { state: "loaded", root: string, version: string, protocolVersion: string, files: ReadonlyMap<string, LoadedWebAppFile>, path?: undefined }
  | { state: "absent", root: string, reason: "root-missing" | "manifest-missing", path?: undefined }
  | { state: "invalid", root: string, reason: WebAppBundleInvalidReason, path?: string }
  | { state: "incompatible", root: string, reason: "protocol-incompatible", bundleProtocolVersion: string, daemonProtocolVersion: string, path?: undefined }

export type WebAppBundleOptions = {
  // The configured directory, absolute.
  root: string
  // Agent-written files live under the profile (worktrees/), and must never be
  // served as the app, so a root whose real path overlaps the profile's is
  // refused, and so is any file with a second hard link. That is a pathname
  // policy: a bind mount or another alias that is not a link can show profile
  // files under an unrelated path, and is not detected. A trusted install
  // location is the supported contract.
  profileDirectory: string
  daemonProtocolVersion?: string
  fileSystem?: WebAppBundleFileSystem
}

class Refusal extends Error {
  constructor(readonly reason: WebAppBundleInvalidReason, readonly path?: string) {
    super(path === undefined ? reason : `${reason}: ${path}`)
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

const posix = process.platform !== "win32"

// Who may change the bundle tree: the daemon's own account and root. Mode
// bits alone do not say that: an entry with mode 0644 owned by another
// account stays writable, and re-permissionable, by that account. So every
// entry the loader reads must be owned by one of these and not writable by
// group or others. fs.access(W_OK) is no substitute: it answers for the
// daemon's account, not for anyone else's.
//
// Stated limit: access control lists are not read. macOS ACLs and Windows
// ACLs can grant another account rights the mode bits do not show, and on
// Windows neither ownership nor mode is checked at all, as for the TLS key in
// tls-material.ts. Installing the bundle in a location only the owner (or an
// administrator) controls is the supported contract.
function trustedOwner(stats: BigIntStats): boolean {
  const effective = process.geteuid?.()
  return !posix || effective === undefined || stats.uid === BigInt(effective) || stats.uid === 0n
}

function writableByOthers(stats: BigIntStats): boolean {
  return posix && (stats.mode & 0o022n) !== 0n
}

// A directory others can write lets them rename or replace what is in it,
// unless the sticky bit limits that to each entry's owner (as /tmp).
function replaceableByOthers(stats: BigIntStats): boolean {
  return writableByOthers(stats) && (stats.mode & 0o1000n) === 0n
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function within(parent: string, child: string): boolean {
  const fold = (path: string) => posix ? path : path.toLowerCase()
  const path = relative(fold(parent), fold(child))
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

// The real path of the nearest existing ancestor, with the rest as written,
// so a profile that does not exist yet still compares by real path.
async function canonicalPath(fileSystem: WebAppBundleFileSystem, path: string): Promise<string> {
  const absolute = resolve(path)
  const rest: string[] = []
  for (let current = absolute; ;) {
    try {
      return join(await fileSystem.realpath(current), ...rest)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      rest.unshift(basename(current))
      current = parent
    }
  }
}

// Reads at most limit + 1 bytes, so a file that grew after fstat is seen as
// longer rather than read without bound.
async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

class BundleReader {
  readonly #fileSystem: WebAppBundleFileSystem
  readonly #root: string
  readonly #rootStats: BigIntStats
  readonly #directories = new Map<string, BigIntStats>()
  // Device and inode of every file read, so two listed paths that reach one
  // file through an alias the grammar cannot see are refused.
  readonly #files = new Set<string>()

  constructor(fileSystem: WebAppBundleFileSystem, root: string, rootStats: BigIntStats) {
    this.#fileSystem = fileSystem
    this.#root = root
    this.#rootStats = rootStats
  }

  async #lstat(path: string, listed: string): Promise<BigIntStats> {
    try {
      return await this.#fileSystem.lstat(path, { bigint: true })
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT") throw new Refusal("file-missing", listed)
      if (code === "ENOTDIR") throw new Refusal("not-a-directory", listed)
      throw new Refusal("file-unreadable", listed)
    }
  }

  // Each directory from the root to the file's parent: a real directory, not
  // a link, not writable by others, and the same one every time it is read.
  async #checkDirectories(segments: readonly string[], listed: string): Promise<void> {
    const root = await this.#lstat(this.#root, listed)
    if (!sameEntry(root, this.#rootStats)) throw new Refusal(root.isSymbolicLink() ? "symbolic-link" : "file-changed")
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments.slice(0, index + 1).join("/")
      const stats = await this.#lstat(join(this.#root, ...segments.slice(0, index + 1)), listed)
      if (stats.isSymbolicLink()) throw new Refusal("symbolic-link", name)
      if (!stats.isDirectory()) throw new Refusal("not-a-directory", name)
      if (!trustedOwner(stats)) throw new Refusal("owner-untrusted", name)
      if (writableByOthers(stats)) throw new Refusal("directory-writable", name)
      const seen = this.#directories.get(name)
      if (seen === undefined) this.#directories.set(name, stats)
      else if (!sameEntry(seen, stats)) throw new Refusal("file-changed", name)
    }
  }

  // The bytes of one file under the root. size is the exact size the manifest
  // lists; maximum bounds a file whose size is not known yet (the manifest).
  async read(listed: string, expected: { size: number } | { maximum: number, tooLarge: WebAppBundleInvalidReason }): Promise<Buffer> {
    const segments = listed.split("/")
    const directories = segments.slice(0, -1)
    await this.#checkDirectories(directories, listed)
    const path = join(this.#root, ...segments)
    const entry = await this.#lstat(path, listed)
    if (entry.isSymbolicLink()) throw new Refusal("symbolic-link", listed)
    if (!entry.isFile()) throw new Refusal("not-regular-file", listed)

    let handle: FileHandle
    try {
      handle = await this.#fileSystem.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    } catch (error) {
      const code = errorCode(error)
      // O_NOFOLLOW refuses a link swapped in after lstat: ELOOP, or EMLINK on FreeBSD.
      if (code === "ELOOP" || code === "EMLINK") throw new Refusal("symbolic-link", listed)
      if (code === "ENOENT" || code === "ENXIO") throw new Refusal("file-changed", listed)
      throw new Refusal("file-unreadable", listed)
    }
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameEntry(opened, entry)) throw new Refusal("file-changed", listed)
      if (!trustedOwner(opened)) throw new Refusal("owner-untrusted", listed)
      if (writableByOthers(opened)) throw new Refusal("file-writable", listed)
      // A second name for the file can sit anywhere on the volume, the
      // profile's worktrees included, where a path check cannot see it.
      if (opened.nlink > 1n) throw new Refusal("hard-link", listed)
      const identity = `${opened.dev}:${opened.ino}`
      if (this.#files.has(identity)) throw new Refusal("duplicate-file", listed)
      this.#files.add(identity)
      let bytes: Buffer
      if ("size" in expected) {
        if (opened.size !== BigInt(expected.size)) throw new Refusal("size-mismatch", listed)
        bytes = await readBounded(handle, expected.size)
        if (bytes.length !== expected.size) throw new Refusal("size-mismatch", listed)
      } else {
        if (opened.size > BigInt(expected.maximum)) throw new Refusal(expected.tooLarge, listed)
        bytes = await readBounded(handle, expected.maximum)
        if (bytes.length > expected.maximum) throw new Refusal(expected.tooLarge, listed)
      }
      // A directory swapped for a link while the file was open would have
      // made the open follow it.
      await this.#checkDirectories(directories, listed)
      return bytes
    } catch (error) {
      if (error instanceof Refusal) throw error
      throw new Refusal("file-unreadable", listed)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}

// Whoever can replace a directory above the real root can replace the root
// itself, whatever the root's own mode. Every ancestor up to the file system
// root must be owned by a trusted account and not replaceable by others.
// These refusals name the ancestor by its absolute path.
async function checkAncestors(fileSystem: WebAppBundleFileSystem, root: string): Promise<void> {
  for (let current = dirname(root); ; current = dirname(current)) {
    let stats: BigIntStats
    try {
      stats = await fileSystem.lstat(current, { bigint: true })
    } catch {
      throw new Refusal("root-unreadable", current)
    }
    if (stats.isSymbolicLink()) throw new Refusal("symbolic-link", current)
    if (!trustedOwner(stats)) throw new Refusal("ancestor-owner-untrusted", current)
    if (replaceableByOthers(stats)) throw new Refusal("ancestor-writable", current)
    if (dirname(current) === current) return
  }
}

function frozen<T extends WebAppBundleLoad>(result: T): T {
  return Object.freeze(result)
}

export async function loadWebAppBundle(options: WebAppBundleOptions): Promise<WebAppBundleLoad> {
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const daemonProtocolVersion = options.daemonProtocolVersion ?? protocolVersion

  let root: string
  try {
    root = await fileSystem.realpath(options.root)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return frozen({ state: "absent", root: options.root, reason: "root-missing" })
    return frozen({ state: "invalid", root: options.root, reason: "root-unreadable" })
  }

  try {
    let rootStats: BigIntStats
    try {
      rootStats = await fileSystem.lstat(root, { bigint: true })
    } catch {
      throw new Refusal("root-unreadable")
    }
    if (!rootStats.isDirectory()) throw new Refusal("root-not-directory")
    const profile = await canonicalPath(fileSystem, options.profileDirectory)
    if (within(profile, root) || within(root, profile)) throw new Refusal("root-in-profile")
    if (!trustedOwner(rootStats)) throw new Refusal("owner-untrusted")
    if (writableByOthers(rootStats)) throw new Refusal("root-writable")
    await checkAncestors(fileSystem, root)

    const reader = new BundleReader(fileSystem, root, rootStats)
    try {
      await fileSystem.lstat(join(root, webBundleManifestFileName), { bigint: true })
    } catch (error) {
      if (errorCode(error) === "ENOENT") return frozen({ state: "absent", root, reason: "manifest-missing" })
    }
    const manifestBytes = await reader.read(webBundleManifestFileName, { maximum: maximumWebBundleManifestBytes, tooLarge: "manifest-too-large" })
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes))
    } catch {
      throw new Refusal("manifest-not-json", webBundleManifestFileName)
    }
    const parsed = parseWebBundleManifest(value)
    if (!parsed.success) throw new Refusal(parsed.reason, parsed.path)
    const { manifest } = parsed
    if (webBundleCompatibility(manifest.protocolVersion, daemonProtocolVersion) !== "compatible") {
      return frozen({
        state: "incompatible", root, reason: "protocol-incompatible",
        bundleProtocolVersion: manifest.protocolVersion, daemonProtocolVersion,
      })
    }

    const files = new Map<string, LoadedWebAppFile>()
    for (const listed of Object.keys(manifest.files).sort()) {
      const { sha256, bytes: size } = manifest.files[listed]!
      const bytes = await reader.read(listed, { size })
      if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Refusal("digest-mismatch", listed)
      files.set(`/${listed}`, Object.freeze({
        bytes,
        // The manifest schema admits only paths whose extension is in the table.
        contentType: webBundleContentType(listed)!,
        sha256,
        etag: `"${sha256}"`,
        cacheClass: webAppCacheClass(listed),
      }))
    }
    return frozen({ state: "loaded", root, version: manifest.version, protocolVersion: manifest.protocolVersion, files })
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    return frozen({ state: "invalid", root, reason: error.reason, ...(error.path === undefined ? {} : { path: error.path }) })
  }
}
