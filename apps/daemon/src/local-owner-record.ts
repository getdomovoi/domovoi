import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, posix, win32 } from "node:path"

import { credentialSchema, fleetDirectEndpointSchema } from "@getdomovoi/protocol"
import { z } from "zod"

import { loadOrCreateDaemonToken } from "./credentials.js"
import { localOwnerIdentitySchema, localOwnerSecretSchema, type LocalOwnerSecret } from "./local-owner-proof.js"
import type { OperationDeadline } from "./operation-deadline.js"

const absolutePath = z.string().min(1).max(4096)
  .refine((path) => posix.isAbsolute(path) || win32.isAbsolute(path))
const ownerFields = {
  ...localOwnerIdentitySchema.shape,
  version: z.literal(1),
  owner: z.enum(["daemon", "desktop"]),
  serviceRegistrationId: z.uuid().optional(),
  credential: z.discriminatedUnion("source", [
    z.object({ source: z.literal("environment") }).strict(),
    z.object({ source: z.literal("file"), path: absolutePath }).strict(),
  ]),
  certificatePath: absolutePath.optional(),
}
export const localOwnerRecordSchema = z.discriminatedUnion("state", [
  z.object({ version: z.literal(1), state: z.literal("none") }).strict(),
  z.object({ ...ownerFields, state: z.literal("starting") }).strict(),
  z.object({ ...ownerFields, state: z.literal("ready"), url: fleetDirectEndpointSchema }).strict(),
  z.object({ ...ownerFields, state: z.literal("stopping") }).strict(),
]).superRefine((record, context) => {
  if (record.state !== "none" && record.owner !== "daemon" && record.serviceRegistrationId !== undefined) {
    context.addIssue({ code: "custom", path: ["serviceRegistrationId"], message: "Only a daemon owner may carry a service registration" })
  }
})
export type LocalOwnerRecord = z.infer<typeof localOwnerRecordSchema>
export type ReadyLocalOwner = Extract<LocalOwnerRecord, { state: "ready" }>
export const maximumLocalOwnerRecordBytes = 16 * 1024

export function localOwnerRecordPath(homeDirectory: string): string {
  return join(homeDirectory, ".domovoi", "local-owner.json")
}

export function localOwnerSecretPath(homeDirectory: string): string {
  return join(homeDirectory, ".domovoi", "local-owner.key")
}

// These bounded, local metadata operations are serialized while holding the
// profile lease. No queued rename may outlive release and replace a new owner.
export function writeLocalOwnerRecord(homeDirectory: string, record: LocalOwnerRecord): void {
  const parsed = localOwnerRecordSchema.parse(record)
  const text = `${JSON.stringify(parsed)}\n`
  if (Buffer.byteLength(text) > maximumLocalOwnerRecordBytes) throw new Error("Local owner record exceeds its size limit")
  const path = localOwnerRecordPath(homeDirectory)
  const staging = `${path}.${randomUUID()}.partial`
  try {
    writeFileSync(staging, text, { mode: 0o600, flag: "wx" })
    if (process.platform !== "win32") chmodSync(staging, 0o600)
    renameSync(staging, path)
  } finally {
    rmSync(staging, { force: true })
  }
}

export function readLocalOwnerRecord(homeDirectory: string): LocalOwnerRecord | undefined {
  const path = localOwnerRecordPath(homeDirectory)
  try {
    const contents = readLocalProfileFile(path, maximumLocalOwnerRecordBytes)
    return localOwnerRecordSchema.parse(JSON.parse(contents))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    // Invalid contents may include secrets, so parser details never leave here.
    // eslint-disable-next-line preserve-caught-error -- Zod details may contain credential material from corrupt metadata.
    throw new Error("The local daemon owner record is invalid or inaccessible")
  }
}

export async function createLocalOwnerSecret(homeDirectory: string, rootBearer: string, deadline: OperationDeadline): Promise<LocalOwnerSecret> {
  const secret = localOwnerSecretSchema.parse(await loadOrCreateDaemonToken(localOwnerSecretPath(homeDirectory), deadline))
  if (secret === rootBearer) throw new Error("The local owner challenge key must differ from the daemon credential")
  return secret
}

export function readLocalOwnerSecret(homeDirectory: string): LocalOwnerSecret {
  return localOwnerSecretSchema.parse(readLocalProfileFile(localOwnerSecretPath(homeDirectory), 256).trim())
}

export function readLocalOwnerCredential(record: ReadyLocalOwner, environmentToken: string | undefined): string {
  const token = record.credential.source === "environment"
    ? environmentToken
    : readLocalProfileFile(record.credential.path, 256).trim()
  const parsed = credentialSchema.safeParse(token)
  if (!parsed.success) throw new Error("The local daemon credential is unavailable")
  return parsed.data
}

export function readLocalProfileFile(path: string, maximumBytes: number, privateFile = true): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > maximumBytes || (privateFile && process.platform !== "win32"
      && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error("Local profile metadata must be a private bounded file")
    }
    const buffer = Buffer.alloc(maximumBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > maximumBytes) throw new Error("Local profile metadata exceeds its size limit")
    return buffer.subarray(0, length).toString("utf8")
  } finally {
    closeSync(descriptor)
  }
}
