import { profileDirectory, type ProfileLocation } from "./profile-directory.js"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import { publishFileDurably } from "@getdomovoi/credential-store"
import { updateVersionSchema } from "@getdomovoi/protocol"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { readLocalProfileFile } from "./local-owner-record.js"

import { assertProfileLeaseHeld, type ProfileLease } from "./profile-lease.js"
import { install as shippedBootstrapInstall } from "./bootstrap-install.js"
import { maximumUpdateMetadataBytes, resetUpdateRoles, type TrustedUpdateDocuments } from "./update-verification.js"

export type TrustedUpdateMetadata = {
  format: 1
  documents?: TrustedUpdateDocuments | undefined
  rootVersion: number
  rootDigest: string
  timestampVersion: number
  timestampDigest: string
  snapshotVersion: number
  snapshotDigest: string
  targetsVersion: number
  targetsDigest: string
}

export type BootstrapInstall = (options: {
  version: string
  baseUrl: string
  destination: string
  expectedSha256: string
}) => Promise<{ version: string, path: string, sha256: string }>

/** The production seam is the reviewed bootstrap installer, not a second extractor. */
export const bootstrapInstall: BootstrapInstall = async (options) => {
  return shippedBootstrapInstall(options)
}

export type VerifiedUpdateTarget = {
  name: string
  version: string
  sha256: string
  channel: "stable" | "beta"
  sourceCommit: string
  runtimeLockDigest: string
}

const trustedUpdateMetadataSchema = z.object({
  format: z.literal(1),
  documents: z.object({
    root: z.string().max(maximumUpdateMetadataBytes),
    timestamp: z.string().max(maximumUpdateMetadataBytes).optional(),
    snapshot: z.string().max(maximumUpdateMetadataBytes).optional(),
    targets: z.string().max(maximumUpdateMetadataBytes).optional(),
  }).strict().optional(),
  rootVersion: z.number().int().nonnegative(), rootDigest: z.string(),
  timestampVersion: z.number().int().nonnegative(), timestampDigest: z.string(),
  snapshotVersion: z.number().int().nonnegative(), snapshotDigest: z.string(),
  targetsVersion: z.number().int().nonnegative(), targetsDigest: z.string(),
}).strict()

const emptyMetadata: TrustedUpdateMetadata = {
  format: 1,
  rootVersion: 0,
  rootDigest: "",
  timestampVersion: 0,
  timestampDigest: "",
  snapshotVersion: 0,
  snapshotDigest: "",
  targetsVersion: 0,
  targetsDigest: "",
}

function metadataPath(homeDirectory: ProfileLocation): string {
  return join(profileDirectory(homeDirectory), "update-metadata.json")
}

export async function readTrustedUpdateMetadata(homeDirectory: ProfileLocation): Promise<TrustedUpdateMetadata> {
  try {
    const metadata = trustedUpdateMetadataSchema.parse(JSON.parse(await readFile(metadataPath(homeDirectory), "utf8")))
    for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
      const text = metadata.documents?.[role]
      if (text === undefined) continue
      const document = z.object({ signed: z.object({ version: z.number().int().positive().safe() }) }).parse(JSON.parse(text))
      if (Buffer.byteLength(text) > maximumUpdateMetadataBytes
        || document.signed.version !== metadata[`${role}Version`]
        || createHash("sha256").update(text).digest("hex") !== metadata[`${role}Digest`]) {
        throw new Error(`Stored ${role} metadata does not match its trust record`)
      }
    }
    return metadata
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyMetadata
    throw error
  }
}

export async function persistTrustedUpdateMetadata(
  homeDirectory: ProfileLocation,
  lease: ProfileLease,
  next: TrustedUpdateMetadata,
): Promise<TrustedUpdateMetadata> {
  assertProfileLeaseHeld(lease)
  if (next.format !== 1) throw new Error("Unsupported trusted update metadata format")
  const current = await readTrustedUpdateMetadata(homeDirectory)
  const resetVersions = new Set(resetUpdateRoles(current.documents?.root, next.documents?.root).map((role) => `${role}Version`))
  for (const field of ["rootVersion", "timestampVersion", "snapshotVersion", "targetsVersion"] as const) {
    if (!resetVersions.has(field) && next[field] < current[field]) throw new Error(`Trusted update metadata ${field} cannot roll back`)
  }
  const pairs: Array<[keyof TrustedUpdateMetadata, keyof TrustedUpdateMetadata]> = [
    ["rootVersion", "rootDigest"], ["timestampVersion", "timestampDigest"],
    ["snapshotVersion", "snapshotDigest"], ["targetsVersion", "targetsDigest"],
  ]
  for (const [version, digest] of pairs) {
    if (!resetVersions.has(version) && next[version] === current[version] && next[digest] !== current[digest]) {
      throw new Error(`Trusted update metadata ${String(version)} changed at an existing version`)
    }
  }
  const directory = profileDirectory(homeDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${metadataPath(homeDirectory)}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx", flush: true })
    await publishFileDurably(temporary, metadataPath(homeDirectory))
    return next
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Only the verifier calls this, with role files the TUF client accepted. */
export async function persistTrustedUpdateDocuments(
  homeDirectory: ProfileLocation,
  lease: ProfileLease,
  documents: TrustedUpdateDocuments,
): Promise<void> {
  const current = await readTrustedUpdateMetadata(homeDirectory)
  const next: TrustedUpdateMetadata = { ...current, documents }
  const reset = new Set(resetUpdateRoles(current.documents?.root, documents.root))
  for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
    const text = documents[role]
    if (text === undefined) {
      if (reset.has(role)) {
        next[`${role}Version`] = 0
        next[`${role}Digest`] = ""
      }
      continue
    }
    const metadata = z.object({ signed: z.object({ version: z.number().int().positive().safe() }) }).parse(JSON.parse(text))
    next[`${role}Version`] = metadata.signed.version
    next[`${role}Digest`] = createHash("sha256").update(text).digest("hex")
  }
  await persistTrustedUpdateMetadata(homeDirectory, lease, next)
}

export async function stageVerifiedUpdate(options: {
  homeDirectory: ProfileLocation
  lease: ProfileLease
  install?: BootstrapInstall
  target: VerifiedUpdateTarget
  baseUrl: string
  runtimeRoot?: string
}): Promise<{ version: string, path: string, sha256: string }> {
  assertProfileLeaseHeld(options.lease)
  const destination = options.runtimeRoot ?? join(profileDirectory(options.homeDirectory), "runtimes")
  const result = await (options.install ?? bootstrapInstall)({
    version: options.target.version,
    baseUrl: options.baseUrl,
    destination,
    expectedSha256: options.target.sha256,
  })
  if (result.version !== options.target.version || result.sha256 !== options.target.sha256) {
    throw new Error("Bootstrap staged bytes that did not match the verified update target")
  }
  return result
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const activationRuntimeSchema = z.object({
  version: updateVersionSchema,
  sha256: digestSchema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  runtimeLockDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  receiptDigest: digestSchema,
  path: z.string().min(1).max(4096),
}).strict()
export type ActivationRuntime = z.infer<typeof activationRuntimeSchema>

export const activationJournalSchema = z.object({
  format: z.literal(1), id: z.uuid(), generation: z.string().min(1).max(128),
  previousRevision: z.uuid(), rollbackRevision: z.uuid(),
  phase: z.enum(["prepared", "starting", "rollback", "restarting", "committed", "rolled-back"]),
  previous: activationRuntimeSchema, target: activationRuntimeSchema,
}).strict().refine((value) => value.previous.version !== value.target.version,
  "Activation requires distinct immutable versions")
export type ActivationJournal = z.infer<typeof activationJournalSchema>
const maximumActivationJournalBytes = 16 * 1024
const activationJournalPath = (home: ProfileLocation) => join(profileDirectory(home), "update-activation.json")

/** The caller holds the idle fence as well as the profile lease until this settles. */
export async function persistActivationJournal(
  home: ProfileLocation, lease: ProfileLease, journal: ActivationJournal,
): Promise<void> {
  assertProfileLeaseHeld(lease)
  const text = `${JSON.stringify(activationJournalSchema.parse(journal))}\n`
  if (Buffer.byteLength(text) > maximumActivationJournalBytes) throw new Error("Activation journal exceeds its limit")
  const path = activationJournalPath(home)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx", flush: true })
    assertProfileLeaseHeld(lease)
    await publishFileDurably(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function readActivationJournal(home: ProfileLocation): ActivationJournal | undefined {
  try {
    return activationJournalSchema.parse(JSON.parse(readLocalProfileFile(
      activationJournalPath(home), maximumActivationJournalBytes,
    )))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("Activation journal is invalid or inaccessible", { cause: error })
  }
}

/** Bind a signed target to the installer's immutable receipt and actual lock bytes.
 * This does not replace full installed-file verification or D9 provenance evidence.
 * Call only under a held fence whose adapter prevents changes to these runtime bytes.
 */
export function readActivationRuntime(runtimeRoot: string, target: VerifiedUpdateTarget): ActivationRuntime {
  const root = realpathSync(runtimeRoot)
  const release = join(root, `v${updateVersionSchema.parse(target.version)}`)
  const receiptPath = join(release, "runtime.json")
  const text = readLocalProfileFile(receiptPath, 16 * 1024)
  const receipt = z.object({
    format: z.literal(1), version: updateVersionSchema, sha256: digestSchema,
    lockSha256: digestSchema, directory: z.string().regex(/^\.runtime-[A-Za-z0-9_-]+\/package$/),
  }).strict().parse(JSON.parse(text))
  const runtime = resolve(release, receipt.directory)
  const lockPath = join(runtime, "runtime", "lock.json")
  for (const path of [release, receiptPath, runtime, lockPath]) {
    if (realpathSync(path) !== path) throw new Error("Activation runtime must not contain links")
  }
  const lock = readLocalProfileFile(lockPath, 1024 * 1024, false)
  if (receipt.version !== target.version || receipt.sha256 !== target.sha256
    || `sha256:${receipt.lockSha256}` !== target.runtimeLockDigest
    || createHash("sha256").update(lock).digest("hex") !== receipt.lockSha256) {
    throw new Error("Activation runtime does not match the signed target")
  }
  return activationRuntimeSchema.parse({
    version: target.version, sha256: target.sha256, sourceCommit: target.sourceCommit,
    runtimeLockDigest: target.runtimeLockDigest,
    receiptDigest: createHash("sha256").update(text).digest("hex"), path: runtime,
  })
}
