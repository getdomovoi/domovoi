import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { assertProfileLeaseHeld, type ProfileLease } from "./profile-lease.js"

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

function metadataPath(homeDirectory: string): string {
  return join(homeDirectory, ".domovoi", "update-metadata.json")
}

export async function readTrustedUpdateMetadata(homeDirectory: string): Promise<TrustedUpdateMetadata> {
  try {
    return JSON.parse(await readFile(metadataPath(homeDirectory), "utf8")) as TrustedUpdateMetadata
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyMetadata
    throw error
  }
}

export async function persistTrustedUpdateMetadata(
  homeDirectory: string,
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
  const directory = join(homeDirectory, ".domovoi")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${metadataPath(homeDirectory)}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx", flush: true })
    await rename(temporary, metadataPath(homeDirectory))
    return next
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function stageVerifiedUpdate(options: {
  homeDirectory: string
  lease: ProfileLease
  install: BootstrapInstall
  version: string
  baseUrl: string
  expectedSha256: string
  runtimeRoot?: string
}): Promise<{ version: string, path: string, sha256: string }> {
  assertProfileLeaseHeld(options.lease)
  const destination = options.runtimeRoot ?? join(options.homeDirectory, ".domovoi", "runtimes")
  const result = await options.install({
    version: options.version,
    baseUrl: options.baseUrl,
    destination,
    expectedSha256: options.expectedSha256,
  })
  if (result.version !== options.version) throw new Error("Bootstrap staged an unexpected update version")
  return result
}
