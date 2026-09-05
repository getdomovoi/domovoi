import { randomUUID } from "node:crypto"
import { closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { machineIdSchema } from "@getdomovoi/protocol"
import { z } from "zod"

import { readLocalOwnerRecord, readLocalProfileFile, writeLocalOwnerRecord, type LocalOwnerRecord } from "./local-owner-record.js"
import type { OperationDeadline } from "./operation-deadline.js"
import { assertProfileLeaseHeld, type ProfileLease } from "./profile-lease.js"

export const localOwnerRemovalReceiptSchema = z.object({
  version: z.literal(1),
  instanceId: z.uuid(),
  machineId: machineIdSchema,
  // Audit evidence only. Elapsed time never authorizes ownership recovery.
  completedAt: z.iso.datetime(),
  authorization: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("operator"),
      confirmation: z.literal("no-supervisor-will-restart"),
      username: z.string().min(1).max(256),
    }).strict(),
    z.object({
      kind: z.literal("service-removal"),
      registrationId: z.uuid(),
      manager: z.enum(["systemd", "launchd", "task-scheduler"]),
    }).strict(),
  ]),
}).strict()
export type LocalOwnerRemovalReceipt = z.infer<typeof localOwnerRemovalReceiptSchema>
const maximumReceiptBytes = 4_096

export function localOwnerRemovalReceiptPath(homeDirectory: string): string {
  return join(homeDirectory, ".domovoi", "local-owner-removal.json")
}

export function readLocalOwnerRemovalReceipt(homeDirectory: string): LocalOwnerRemovalReceipt | undefined {
  const path = localOwnerRemovalReceiptPath(homeDirectory)
  try {
    return localOwnerRemovalReceiptSchema.parse(JSON.parse(readLocalProfileFile(path, maximumReceiptBytes)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    // No parser details from potentially corrupted profile metadata.
    // eslint-disable-next-line preserve-caught-error -- Parser errors may expose unexpected credential material.
    throw new Error(`The owner removal receipt is invalid or inaccessible at ${path}`)
  }
}

export function writeLocalOwnerRemovalReceipt(
  homeDirectory: string, lease: ProfileLease, receipt: LocalOwnerRemovalReceipt,
  deadline: OperationDeadline,
): void {
  deadline.throwIfExpired()
  assertProfileLeaseHeld(lease)
  const text = `${JSON.stringify(localOwnerRemovalReceiptSchema.parse(receipt))}\n`
  if (Buffer.byteLength(text) > maximumReceiptBytes) throw new Error("Owner removal receipt exceeds its size limit")
  const path = localOwnerRemovalReceiptPath(homeDirectory)
  const staging = `${path}.${randomUUID()}.partial`
  let descriptor: number | undefined
  let published = false
  const failures: unknown[] = []
  const closeFile = () => {
    if (descriptor === undefined) return
    const owned = descriptor
    descriptor = undefined
    // A failed close does not prove the descriptor stayed open. Never close
    // that numeric handle again, which could refer to a different file.
    closeSync(owned)
  }
  try {
    descriptor = openSync(staging, "wx", 0o600)
    writeFileSync(descriptor, text)
    fsyncSync(descriptor)
    closeFile()
    deadline.throwIfExpired()
    renameSync(staging, path)
    published = true
    // Windows does not expose directory fsync through Node. Receipt contents
    // are flushed before rename on every platform; POSIX also flushes the name.
    if (process.platform !== "win32") {
      descriptor = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
      fsyncSync(descriptor)
      closeFile()
    }
  } catch (error) {
    failures.push(error)
  } finally {
    try { closeFile() } catch (error) { failures.push(error) }
    try { rmSync(staging, { force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length === 0) return
  const cause = new AggregateError(failures, "Receipt publication and cleanup failures")
  if (published) {
    const detail = failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("; ")
    // The rename already made the receipt visible. Only the durability flush
    // or a descriptor close failed after publication.
    throw new Error(`Owner removal receipt is published at ${path}, but a step after publication failed: ${detail}. The receipt may not be durable until its directory is flushed; verify it before relying on it.`, { cause })
  }
  throw new Error(`Owner removal receipt publication did not complete at ${path}. A staging file may remain at ${staging}. No ownership recovery was performed.`, { cause })
}

export function retireRemovedLocalOwner(
  homeDirectory: string, lease: ProfileLease, record: Exclude<LocalOwnerRecord, { state: "none" }>,
  deadline: OperationDeadline,
): boolean {
  deadline.throwIfExpired()
  assertProfileLeaseHeld(lease)
  const current = readLocalOwnerRecord(homeDirectory)
  if (!current || current.state === "none" || current.instanceId !== record.instanceId
    || current.machineId !== record.machineId || current.serviceRegistrationId !== record.serviceRegistrationId) return false
  const receipt = readLocalOwnerRemovalReceipt(homeDirectory)
  if (!receipt || receipt.instanceId !== record.instanceId || receipt.machineId !== record.machineId) return false
  if (receipt.authorization.kind === "service-removal"
    && receipt.authorization.registrationId !== record.serviceRegistrationId) return false
  // This is the receipt's consumption point, under the same lease used to
  // construct the next owner. Keep the receipt as evidence; the new instance
  // cannot use it. A crash before publishing a new owner leaves state 'none'.
  deadline.throwIfExpired()
  writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" })
  return true
}
