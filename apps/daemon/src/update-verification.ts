import { createPublicKey, verify as verifySignature } from "node:crypto"

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
  if (raw.length !== 32) throw new UpdateVerificationError("Update signing key is not an Ed25519 key")
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
      ok = verifySignature(null, payload, publicKey(key.keyval.public), Buffer.from(signature.sig, "base64"))
    } catch {
      ok = false
    }
    if (ok) valid.add(signature.keyid)
  }
  if (valid.size < delegation.threshold) throw new UpdateVerificationError(`Update role ${role} did not meet its signature threshold`)
}

export function verifyUpdateRoot(value: unknown, trustedRoot: UpdateRootMetadata): UpdateRootMetadata {
  const envelope = updateRootMetadataSchema.parse(value)
  verifyRoleSignatures("root", envelope, trustedRoot)
  if (envelope.signed.version < trustedRoot.signed.version) throw new UpdateVerificationError("Update root metadata rolls back its version")
  return envelope
}

export function verifyUpdateMetadata(role: Exclude<UpdateRoleName, "root">, value: unknown, root: UpdateRootMetadata): unknown {
  const envelope = role === "targets"
    ? updateTargetsMetadataSchema.parse(value)
    : role === "snapshot" ? updateSnapshotMetadataSchema.parse(value) : updateTimestampMetadataSchema.parse(value)
  verifyRoleSignatures(role, envelope, root)
  return envelope
}

export function selectUpdateTarget(value: unknown, channel: UpdateChannel, currentVersion: string): { name: string, version: string, sourceCommit: string } | undefined {
  const metadata = updateTargetsMetadataSchema.parse(value)
  const candidates = Object.entries(metadata.signed.targets)
    .filter(([name, target]) => target.custom.channel === channel && updateTargetNameSchema.safeParse(name).success)
    .filter(([, target]) => updateVersionSchema.safeParse(target.custom.version).success)
    .filter(([, target]) => target.custom.version !== currentVersion)
    .sort(([, left], [, right]) => left.custom.version.localeCompare(right.custom.version, undefined, { numeric: true }))
  const selected = candidates.at(-1)
  if (!selected) return undefined
  return { name: selected[0], version: selected[1].custom.version, sourceCommit: selected[1].custom.sourceCommit }
}

async function readMetadata(response: Response): Promise<unknown> {
  if (!response.ok) throw new UpdateVerificationError(`Update metadata request failed with HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximumUpdateMetadataBytes) throw new UpdateVerificationError("Update metadata exceeds its byte limit")
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new UpdateVerificationError("Update metadata is not valid JSON", { cause: error })
  }
}

export async function fetchUpdateMetadata(baseUrl: string, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
  if (base.protocol !== "https:") throw new UpdateVerificationError("Update metadata requires HTTPS")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), updateFetchTimeoutMs)
  try {
    const names = ["root.json", "timestamp.json", "snapshot.json", "targets.json"] as const
    const entries = await Promise.all(names.map(async (name) => {
      const url = new URL(name, base)
      if (url.origin !== base.origin) throw new UpdateVerificationError("Update metadata redirect changed origin")
      const response = await fetcher(url, { signal: controller.signal, redirect: "error" })
      return [name, await readMetadata(response)] as const
    }))
    return Object.fromEntries(entries)
  } catch (error) {
    if (error instanceof UpdateVerificationError) throw error
    throw new UpdateVerificationError("Update metadata fetch failed", { cause: error })
  } finally {
    clearTimeout(timer)
  }
}
