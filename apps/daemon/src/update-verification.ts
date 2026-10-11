import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalize } from "@tufjs/canonical-json"
import { Metadata, MetadataKind } from "@tufjs/models"
import { UnsignedMetadataError } from "@tufjs/models/dist/error.js"
import { Updater, type Fetcher } from "tuf-js"
import { z } from "zod"
// These typed errors are not re-exported by the pinned client's entry point.
import { BadVersionError, DownloadHTTPError, ExpiredMetadataError } from "tuf-js/dist/error.js"

import {
  type UpdateChannel, type UpdateRoleName, type UpdateRootMetadata,
  updateRootMetadataSchema, updateTargetsMetadataSchema,
  updateSnapshotMetadataSchema, updateTimestampMetadataSchema,
  updateTargetNameSchema, updateVersionSchema,
} from "@getdomovoi/protocol"

export const maximumUpdateMetadataBytes = 1_048_576
export const updateFetchTimeoutMs = 30_000
export const updateInactivityTimeoutMs = 10_000
export const maximumUpdateRootRotations = 32
export type TrustedUpdateDocuments = Partial<Record<UpdateRoleName, string | undefined>>
const roles = ["root", "timestamp", "snapshot", "targets"] as const
const schemas = { root: updateRootMetadataSchema, timestamp: updateTimestampMetadataSchema, snapshot: updateSnapshotMetadataSchema, targets: updateTargetsMetadataSchema }

export class UpdateVerificationError extends Error {
  constructor(readonly reason: "expired" | "signature" | "replay" | "target-mismatch" | "malformed-metadata" | "network" | "policy", message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "UpdateVerificationError"
  }
}

/** The same OLPC canonicalization as the TUF verifier, also used by signing fixtures. */
export function canonicalUpdateJson(value: unknown): string { return canonicalize(value) }

function parseMetadata(role: UpdateRoleName, text: string) {
  try {
    if (Buffer.byteLength(text) > maximumUpdateMetadataBytes) throw new Error("Metadata exceeds limit")
    const metadata = schemas[role].parse(JSON.parse(text))
    if (new Set(metadata.signatures.map(({ keyid }) => keyid)).size !== metadata.signatures.length
      || metadata.signatures.some(({ sig }) => !/^[a-f0-9]{128}$/.test(sig))) {
      throw new UpdateVerificationError("signature", "Update metadata requires standard TUF Ed25519 signatures")
    }
    return metadata
  } catch (error) {
    if (error instanceof UpdateVerificationError) throw error
    throw new UpdateVerificationError("malformed-metadata", "Update metadata is malformed", { cause: error })
  }
}

function verificationError(error: unknown): UpdateVerificationError {
  if (error instanceof UpdateVerificationError) return error
  const reason = error instanceof UnsignedMetadataError ? "signature"
    : error instanceof ExpiredMetadataError ? "expired"
    : error instanceof BadVersionError ? "replay" : "target-mismatch"
  return new UpdateVerificationError(reason, "TUF update verification failed", { cause: error })
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [withoutBuild] = value.split("+", 2)
    const [core, prerelease] = withoutBuild!.split("-", 2)
    return { core: core!.split(".").map(Number), prerelease: prerelease?.split(".") }
  }
  const a = parse(left); const b = parse(right)
  for (let index = 0; index < 3; index++) if (a.core[index]! !== b.core[index]!) return a.core[index]! > b.core[index]! ? 1 : -1
  if (!a.prerelease && !b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const leftPart = a.prerelease[index]; const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber > rightNumber ? 1 : -1
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export function selectUpdateTarget(value: unknown, channel: UpdateChannel, currentVersion: string): { name: string, version: string, sourceCommit: string } | undefined {
  const metadata = updateTargetsMetadataSchema.parse(value)
  const candidates = Object.entries(metadata.signed.targets)
    .filter(([name, target]) => target.custom.channel === channel && updateTargetNameSchema.safeParse(name).success)
    .filter(([, target]) => updateVersionSchema.safeParse(target.custom.version).success)
    .filter(([, target]) => compareVersions(target.custom.version, currentVersion) > 0)
    .sort(([, left], [, right]) => compareVersions(left.custom.version, right.custom.version))
  const selected = candidates.at(-1)
  if (!selected) return undefined
  return { name: selected[0], version: selected[1].custom.version, sourceCommit: selected[1].custom.sourceCommit }
}

async function readMetadata(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null && Number(contentLength) > limit) {
    void response.body?.cancel().catch(() => {})
    throw new UpdateVerificationError(limit < maximumUpdateMetadataBytes ? "target-mismatch" : "network", "Update metadata exceeds its byte limit")
  }
  if (!response.body) throw new UpdateVerificationError("network", "Update metadata response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            abort = () => reject(new UpdateVerificationError("network", "Update metadata fetch timed out"))
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
            timer = setTimeout(() => reject(new UpdateVerificationError("network", "Update metadata read timed out")), updateInactivityTimeoutMs)
          }),
        ])
        if (result.done) break
        total += result.value.byteLength
        if (total > limit) throw new UpdateVerificationError(limit < maximumUpdateMetadataBytes ? "target-mismatch" : "network", "Update metadata exceeds its byte limit")
        chunks.push(result.value)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (abort) signal.removeEventListener("abort", abort)
      }
    }
  } finally {
    // Do not let a hostile stream's cancel promise hold the update open.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

/** TUF owns root rotation, role ordering, thresholds, expiry, and metadata bindings.
 * Its ordinary cache writes stay in scratch; only verified files are published by
 * the caller's atomic, flushed persistence under the profile lease.
 */
export async function fetchUpdateMetadata(options: {
  baseUrl: string
  trustedRoot: UpdateRootMetadata
  trusted?: TrustedUpdateDocuments
  fetcher?: typeof fetch
  persist: (documents: TrustedUpdateDocuments) => Promise<void>
}): Promise<Record<string, unknown> & { raw: Record<string, Uint8Array> }> {
  const base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`)
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new UpdateVerificationError("network", "Update metadata requires a credential-free HTTPS URL")
  }
  const referenceTime = new Date()
  const directory = await mkdtemp(join(tmpdir(), "domovoi-tuf-"))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), updateFetchTimeoutMs)
  let callbackFailure: unknown
  let lastPublished = ""
  let initialized = false
  let persistenceFailed = false
  const documents: TrustedUpdateDocuments = { ...options.trusted }
  documents.root ??= JSON.stringify(options.trustedRoot)
  const publishProgress = async () => {
    if (!initialized || persistenceFailed) return
    for (const role of roles) {
      try { documents[role] = await readFile(join(directory, `${role}.json`), "utf8") }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error }
    }
    const serialized = JSON.stringify(documents)
    if (serialized !== lastPublished) {
      try { await options.persist({ ...documents }) }
      catch (error) {
        persistenceFailed = true
        throw new UpdateVerificationError("policy", "Verified update metadata could not be persisted", { cause: error })
      }
      lastPublished = serialized
    }
  }
  try {
    for (const role of roles) {
      const text = documents[role]
      if (text !== undefined) {
        parseMetadata(role, text)
        await writeFile(join(directory, `${role}.json`), text, { mode: 0o600, flag: "wx" })
      }
    }
    const fetcher: Fetcher = {
      downloadFile: async () => { throw new Error("Artifact downloads use the verified bootstrap installer") },
      downloadBytes: async (address, requestedLimit) => {
        try {
          // A previous request may have advanced trust before this next await.
          await publishProgress()
          if (controller.signal.aborted) throw new UpdateVerificationError("network", "Update metadata fetch timed out")
          const url = new URL(address)
          if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash) {
            throw new UpdateVerificationError("network", "Update metadata request changed repository")
          }
          const match = /(?:^|\/)(?:[0-9]+\.)?(root|timestamp|snapshot|targets)\.json$/.exec(url.pathname)
          const role = match?.[1] as UpdateRoleName | undefined
          if (!role) throw new UpdateVerificationError("malformed-metadata", "Unsupported update role")
          let response: Response
          try { response = await (options.fetcher ?? fetch)(url, { signal: controller.signal, redirect: "error" }) }
          catch (error) { throw new UpdateVerificationError("network", "Update metadata fetch failed", { cause: error }) }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            if (role === "root" && [403, 404].includes(response.status)) throw new DownloadHTTPError("Root unavailable", response.status)
            throw new UpdateVerificationError("network", "Update metadata request failed")
          }
          if (response.redirected || (response.url && response.url !== url.href)) {
            void response.body?.cancel().catch(() => {})
            throw new UpdateVerificationError("network", "Update metadata redirect refused")
          }
          const bytes = await readMetadata(response, Math.min(requestedLimit, maximumUpdateMetadataBytes), controller.signal)
          let text: string
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
          catch (error) { throw new UpdateVerificationError("malformed-metadata", "Update metadata is not valid UTF-8", { cause: error }) }
          const value = parseMetadata(role, text)
          const previous = documents[role]
          if (previous !== undefined) {
            const old = parseMetadata(role, previous)
            if (value.signed.version < old.signed.version || (value.signed.version === old.signed.version && text !== previous)) {
              throw new UpdateVerificationError("replay", "Update metadata changed at an existing or older version")
            }
          }
          // Validate role signatures using the library before the updater wraps
          // snapshot/targets errors; keep the public refusal taxonomy typed.
          if (role !== "root") {
            const root = Metadata.fromJSON(MetadataKind.Root, updateRootMetadataSchema.parse(JSON.parse(documents.root!)))
            const metadata = role === "timestamp" ? Metadata.fromJSON(MetadataKind.Timestamp, updateTimestampMetadataSchema.parse(value))
              : role === "snapshot" ? Metadata.fromJSON(MetadataKind.Snapshot, updateSnapshotMetadataSchema.parse(value))
                : Metadata.fromJSON(MetadataKind.Targets, z.record(z.string(), z.json()).parse(value))
            root.verifyDelegate(role, metadata)
            if (metadata.signed.isExpired(referenceTime)) throw new ExpiredMetadataError("Update metadata expired")
          }
          return bytes
        } catch (error) {
          // Missing next root is the library's normal completion signal.
          if (!(error instanceof DownloadHTTPError)) callbackFailure = error
          throw error
        }
      },
    }
    const updater = new Updater({ metadataDir: directory, metadataBaseUrl: base.href, fetcher,
      config: { maxRootRotations: maximumUpdateRootRotations, rootMaxLength: maximumUpdateMetadataBytes,
        timestampMaxLength: maximumUpdateMetadataBytes, snapshotMaxLength: maximumUpdateMetadataBytes,
        targetsMaxLength: maximumUpdateMetadataBytes, maxDelegations: 0, fetchRetry: 0 } })
    initialized = true
    await updater.refresh()
    await publishProgress()
    const raw: Record<string, Uint8Array> = {}
    const values: Record<string, unknown> = {}
    for (const role of roles) {
      raw[`${role}.json`] = Buffer.from(documents[role]!)
      values[`${role}.json`] = parseMetadata(role, documents[role]!)
    }
    return { ...values, raw }
  } catch (error) {
    throw verificationError(callbackFailure ?? error)
  } finally {
    clearTimeout(timer)
    controller.abort()
    try { await publishProgress() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}
