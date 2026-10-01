import { z } from "zod"

import { protocolCompatibility, protocolVersion, protocolVersionSchema, type ProtocolCompatibility } from "./protocol-version.js"
import { utf16MaxLength } from "./validation.js"

// The web app bundle the daemon serves (S3.2, docs/plans/s3-2-web-over-tailnet.md
// section 1): the output of `vite build` in apps/web plus one manifest the build
// writes. The web build that writes the manifest and the daemon that reads it
// share this schema. It is not wire: nothing here crosses a socket, so the wire
// record (scripts/protocol-wire.mjs) does not list it and adding it is no
// protocol bump.
//
// `files` is the complete allow-list of what the daemon serves. The digests
// detect a partial or mixed copy. They are not authentication: they come from
// the same place as the files.
export const webBundleManifestFileName = "domovoi-web.json"
export const webBundleFormat = 1

// Provisional bounds with wide headroom over a 2026-09 build of apps/web
// (22 files, largest 555 KB, 1.8 MB in all). S3.2 slice 2 measures the real
// bundle and sets them from that, as the coverage floors were set. The daemon
// holds every file in memory, so these bound what one bundle can cost it.
export const maximumWebBundleManifestBytes = 256 * 1024
export const maximumWebBundleFiles = 512
export const maximumWebBundleFileBytes = 8 * 1024 * 1024
export const maximumWebBundleBytes = 32 * 1024 * 1024
export const maximumWebBundlePathLength = 255
const maximumWebBundleVersionLength = 64

// The content type comes from this table, never from a file's bytes. An
// extension outside it is refused, so the daemon never guesses a type.
const contentTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
])

// First path segments the daemon answers itself. A bundle cannot shadow the
// socket, the health probe or preview access. Compared without case, so a
// case-insensitive file system cannot make two spellings of one route.
const reservedFirstSegments = new Set(["rpc", "healthz", "artifacts"])

// One segment: ASCII letters, digits, "_", "-" and ".", not starting with ".".
// That leaves out ".", "..", hidden files, "%" escapes, backslashes, NUL,
// spaces, colons and every non-ASCII character, so a listed path cannot
// traverse or alias by construction, before any file system is consulted.
const segmentPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?![\s\S])/

export type WebBundlePathRefusal = "path-malformed" | "path-reserved" | "path-extension"

export function webBundleContentType(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? undefined : contentTypes.get(name.slice(dot))
}

// A manifest path is plain and relative: segments joined by single "/",
// no leading "/", no empty, "." or ".." segment.
export function webBundlePathRefusal(path: string): WebBundlePathRefusal | undefined {
  if (path.length === 0 || path.length > maximumWebBundlePathLength) return "path-malformed"
  const segments = path.split("/")
  if (!segments.every((segment) => segmentPattern.test(segment))) return "path-malformed"
  if (path === webBundleManifestFileName || reservedFirstSegments.has(segments[0]!.toLowerCase())) return "path-reserved"
  if (webBundleContentType(path) === undefined) return "path-extension"
  return undefined
}

// The workspace version the bundle was built at: provenance, not compatibility.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/
const sha256Pattern = /^[0-9a-f]{64}(?![\s\S])/

const webBundleFileSchema = z.object({
  sha256: z.string().regex(sha256Pattern, "Expected a lowercase hex SHA-256 digest"),
  bytes: z.number().int().min(0),
}).strict()

function manifestShape<Key extends z.ZodType<string, string>>(key: Key) {
  return z.object({
    format: z.literal(webBundleFormat),
    version: z.string().check(utf16MaxLength(maximumWebBundleVersionLength)).regex(versionPattern, "Expected a release version"),
    // Shape only. Compatibility is the daemon's decision (webBundleCompatibility),
    // so a bundle for another protocol minor still parses and is reported as such.
    protocolVersion: protocolVersionSchema,
    files: z.record(key, webBundleFileSchema),
  }).strict()
}

// Keys are not checked here, so the rules below can name the path they refuse.
const looseManifestSchema = manifestShape(z.string())

const webBundlePathSchema = z.string().refine((path) => webBundlePathRefusal(path) === undefined, "Expected a plain relative path with an allowed extension")

export type WebBundleManifestRefusal =
  | "manifest-schema"
  | WebBundlePathRefusal
  | "missing-index"
  | "too-many-files"
  | "file-too-large"
  | "bundle-too-large"

type FilesRefusal = { reason: Exclude<WebBundleManifestRefusal, "manifest-schema">, path?: string }

function filesRefusal(files: Record<string, { bytes: number }>): FilesRefusal | undefined {
  // Own keys of the object as given. JSON.parse keeps "__proto__" as an own
  // key, which an assignment-built copy would turn into a prototype instead.
  const paths = Object.keys(files)
  if (paths.length > maximumWebBundleFiles) return { reason: "too-many-files" }
  for (const path of paths) {
    const refused = webBundlePathRefusal(path)
    if (refused !== undefined) return { reason: refused, path }
  }
  let total = 0
  for (const path of paths) {
    const { bytes } = Object.getOwnPropertyDescriptor(files, path)!.value as { bytes: number }
    if (bytes > maximumWebBundleFileBytes) return { reason: "file-too-large", path }
    total += bytes
  }
  if (total > maximumWebBundleBytes) return { reason: "bundle-too-large" }
  // The document served at "/".
  if (!Object.hasOwn(files, "index.html")) return { reason: "missing-index" }
  return undefined
}

// The rules read the input, not the parsed copy: zod's record drops a
// "__proto__" key from its output without checking it, so a rule run on the
// output would never see that entry. The shape itself is checked by the pipe.
export const webBundleManifestSchema = z.unknown().superRefine((value, context) => {
  if (!looseManifestSchema.safeParse(value).success) return
  const refused = filesRefusal((value as { files: Record<string, { bytes: number }> }).files)
  if (refused === undefined) return
  context.addIssue({
    code: "custom",
    message: `Web bundle manifest refused: ${refused.reason}`,
    path: refused.path === undefined ? ["files"] : ["files", refused.path],
  })
}).pipe(manifestShape(webBundlePathSchema))

export type WebBundleManifest = z.infer<typeof webBundleManifestSchema>

export type WebBundleManifestParse =
  | { success: true, manifest: WebBundleManifest }
  | { success: false, reason: WebBundleManifestRefusal, path?: string }

// The schema with a typed reason: "manifest-schema" for a wrong shape, else
// the first path or bound rule that refused, with the path it names.
export function parseWebBundleManifest(value: unknown): WebBundleManifestParse {
  if (!looseManifestSchema.safeParse(value).success) return { success: false, reason: "manifest-schema" }
  const refused = filesRefusal((value as { files: Record<string, { bytes: number }> }).files)
  if (refused !== undefined) return { success: false, ...refused }
  const parsed = webBundleManifestSchema.safeParse(value)
  return parsed.success ? { success: true, manifest: parsed.data } : { success: false, reason: "manifest-schema" }
}

// The existing admission rule (docs/protocol-version-negotiation.md): major
// and minor must match, patch may differ. The daemon is the machine.
export function webBundleCompatibility(bundleProtocolVersion: string, daemonProtocolVersion: string = protocolVersion): ProtocolCompatibility {
  return protocolCompatibility(daemonProtocolVersion, bundleProtocolVersion)
}
