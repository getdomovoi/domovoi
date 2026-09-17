import { profileDirectory, type ProfileLocation } from "./profile-directory.js"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import { publishFileDurably } from "@getdomovoi/credential-store"

import { assertProfileLeaseHeld, type ProfileLease } from "./profile-lease.js"
import { install as shippedBootstrapInstall } from "./bootstrap-install.js"

export type TrustedUpdateMetadata = {
  format: 1
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
    return trustedUpdateMetadataSchema.parse(JSON.parse(await readFile(metadataPath(homeDirectory), "utf8")))
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
  for (const field of ["rootVersion", "timestampVersion", "snapshotVersion", "targetsVersion"] as const) {
    if (next[field] < current[field]) throw new Error(`Trusted update metadata ${field} cannot roll back`)
  }
  const pairs: Array<[keyof TrustedUpdateMetadata, keyof TrustedUpdateMetadata]> = [
    ["rootVersion", "rootDigest"], ["timestampVersion", "timestampDigest"],
    ["snapshotVersion", "snapshotDigest"], ["targetsVersion", "targetsDigest"],
  ]
  for (const [version, digest] of pairs) {
    if (next[version] === current[version] && next[digest] !== current[digest]) {
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
