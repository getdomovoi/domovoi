import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"

import {
  type UpdateChannel,
  type UpdateRoleName,
  type UpdateRootMetadata,
  updateRootMetadataSchema,
  updateTargetsMetadataSchema,
  updateSnapshotMetadataSchema,
  updateTimestampMetadataSchema,
  updateTargetNameSchema,
  updateVersionSchema,
} from "@getdomovoi/protocol"

export const maximumUpdateMetadataBytes = 1_048_576
export const updateFetchTimeoutMs = 30_000
export const updateInactivityTimeoutMs = 10_000

export class UpdateVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "UpdateVerificationError"
  }
}

/** TUF signatures cover canonical JSON of the signed object, never the envelope. */
export function canonicalUpdateJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalUpdateJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalUpdateJson(entry)}`).join(",")}}`
}

function publicKey(value: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(value, "base64")
  if (raw.length !== 32 || raw.toString("base64") !== value) throw new UpdateVerificationError("Update signing key is not a canonical Ed25519 key")
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw])
  return createPublicKey({ key: spki, format: "der", type: "spki" })
}

function verifyRoleSignatures(role: UpdateRoleName, envelope: { signed: unknown, signatures: Array<{ keyid: string, sig: string }> }, root: UpdateRootMetadata): void {
  const delegation = root.signed.roles[role]
  if (!delegation) throw new UpdateVerificationError(`Update role ${role} is not delegated`)
  const keys = new Set(delegation.keyids)
  const valid = new Set<string>()
  const payload = Buffer.from(canonicalUpdateJson(envelope.signed), "utf8")
  for (const signature of envelope.signatures) {
    if (!keys.has(signature.keyid) || valid.has(signature.keyid)) continue
    const key = root.signed.keys[signature.keyid]
    if (!key) continue
    let ok = false
    try {
      const signatureBytes = Buffer.from(signature.sig, "base64")
      ok = signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.sig
        && verifySignature(null, payload, publicKey(key.keyval.public), signatureBytes)
    } catch {
      ok = false
    }
    if (ok) valid.add(signature.keyid)
  }
  if (valid.size < delegation.threshold) throw new UpdateVerificationError(`Update role ${role} did not meet its signature threshold`)
}

function assertFresh(expires: string, now: number): void {
  if (Date.parse(expires) <= now) throw new UpdateVerificationError("Update metadata is expired")
}

function metadataDigest(bytes: Uint8Array): { length: number, sha256: string } {
  return { length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
}

function compareVersions(left: string, right: string): number {
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

export function verifyUpdateRoot(value: unknown, trustedRoot: UpdateRootMetadata): UpdateRootMetadata {
  const envelope = updateRootMetadataSchema.parse(value)
  verifyRoleSignatures("root", envelope, trustedRoot)
  if (envelope.signed.version < trustedRoot.signed.version) throw new UpdateVerificationError("Update root metadata rolls back its version")
  if (envelope.signed.version === trustedRoot.signed.version
    && canonicalUpdateJson(envelope.signed) !== canonicalUpdateJson(trustedRoot.signed)) {
    throw new UpdateVerificationError("Update root metadata changed at an existing version")
  }
  verifyRoleSignatures("root", envelope, envelope)
  return envelope
}

export function verifyUpdateMetadata(role: Exclude<UpdateRoleName, "root">, value: unknown, root: UpdateRootMetadata): unknown {
  const envelope = role === "targets"
    ? updateTargetsMetadataSchema.parse(value)
    : role === "snapshot" ? updateSnapshotMetadataSchema.parse(value) : updateTimestampMetadataSchema.parse(value)
  verifyRoleSignatures(role, envelope, root)
  assertFresh(envelope.signed.expires, Date.now())
  return envelope
}

export function verifyUpdateChain(values: { root: unknown, timestamp: unknown, snapshot: unknown, targets: unknown, raw: Record<string, Uint8Array> }, trustedRoot: UpdateRootMetadata, now = Date.now()): UpdateRootMetadata {
  const root = verifyUpdateRoot(values.root, trustedRoot)
  assertFresh(root.signed.expires, now)
  const timestamp = updateTimestampMetadataSchema.parse(values.timestamp)
  const snapshot = updateSnapshotMetadataSchema.parse(values.snapshot)
  const targets = updateTargetsMetadataSchema.parse(values.targets)
  for (const metadata of [timestamp, snapshot, targets]) assertFresh(metadata.signed.expires, now)
  verifyRoleSignatures("timestamp", timestamp, root)
  verifyRoleSignatures("snapshot", snapshot, root)
  verifyRoleSignatures("targets", targets, root)
  const snapshotMeta = timestamp.signed.meta["snapshot.json"]
  const targetsMeta = snapshot.signed.meta["targets.json"]
  if (!snapshotMeta || snapshotMeta.version !== snapshot.signed.version) throw new UpdateVerificationError("Timestamp does not bind the snapshot version")
  if (!targetsMeta || targetsMeta.version !== targets.signed.version) throw new UpdateVerificationError("Snapshot does not bind the targets version")
  const snapshotBytes = values.raw["snapshot.json"]
  const targetsBytes = values.raw["targets.json"]
  if (!snapshotBytes || !targetsBytes) throw new UpdateVerificationError("Update metadata is missing served bytes for binding")
  const snapshotDigest = metadataDigest(snapshotBytes)
  const targetsDigest = metadataDigest(targetsBytes)
  if (snapshotMeta.length !== snapshotDigest.length || snapshotMeta.hashes.sha256 !== snapshotDigest.sha256) throw new UpdateVerificationError("Timestamp does not bind the snapshot bytes")
  if (targetsMeta.length !== targetsDigest.length || targetsMeta.hashes.sha256 !== targetsDigest.sha256) throw new UpdateVerificationError("Snapshot does not bind the targets bytes")
  return root
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

async function readMetadata(response: Response): Promise<{ value: unknown, bytes: Uint8Array }> {
  if (!response.ok) throw new UpdateVerificationError(`Update metadata request failed with HTTP ${response.status}`)
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null && Number(contentLength) > maximumUpdateMetadataBytes) throw new UpdateVerificationError("Update metadata exceeds its byte limit")
  if (!response.body) throw new UpdateVerificationError("Update metadata response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new UpdateVerificationError("Update metadata read timed out")), updateInactivityTimeoutMs) }),
        ])
        if (result.done) break
        total += result.value.byteLength
        if (total > maximumUpdateMetadataBytes) {
          await reader.cancel()
          throw new UpdateVerificationError("Update metadata exceeds its byte limit")
        }
        chunks.push(result.value)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), bytes }
  } catch (error) {
    throw new UpdateVerificationError("Update metadata is not valid JSON", { cause: error })
  }
}

export async function fetchUpdateMetadata(baseUrl: string, fetcher: typeof fetch = fetch): Promise<Record<string, unknown> & { raw: Record<string, Uint8Array> }> {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
  if (base.protocol !== "https:") throw new UpdateVerificationError("Update metadata requires HTTPS")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), updateFetchTimeoutMs)
  try {
    const names = ["root.json", "timestamp.json", "snapshot.json", "targets.json"] as const
    const entries: Array<readonly [string, { value: unknown, bytes: Uint8Array }]> = []
    for (const name of names) {
      const url = new URL(name, base)
      if (url.origin !== base.origin) throw new UpdateVerificationError("Update metadata redirect changed origin")
      const response = await fetcher(url, { signal: controller.signal, redirect: "error" })
      entries.push([name, await readMetadata(response)])
    }
    const raw = Object.fromEntries(entries.map(([name, document]) => [name, document.bytes]))
    return { ...Object.fromEntries(entries.map(([name, document]) => [name, document.value])), raw }
  } catch (error) {
    if (error instanceof UpdateVerificationError) throw error
    throw new UpdateVerificationError("Update metadata fetch failed", { cause: error })
  } finally {
    clearTimeout(timer)
  }
}
