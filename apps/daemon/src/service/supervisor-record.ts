import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { z } from "zod"

import { readLocalProfileFile } from "../local-owner-record.js"

export const supervisorBackoffs = [1000, 5000, 15000] as const
const maximumRecordBytes = 16 * 1024
const count = z.number().int().min(0).max(4)
export const guestProcessIdentitySchema = z.object({
  pid: z.number().int().min(1).max(2_147_483_647), start: z.string().regex(/^[0-9]{1,24}$/), bootId: z.uuid(),
}).strict()
export type GuestProcessIdentity = z.infer<typeof guestProcessIdentitySchema>
const exitSchema = z.object({
  kind: z.enum(["clean", "crash", "stopped", "launch-failed"]),
  code: z.number().int().min(0).max(4_294_967_295).nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]{1,24}$/).nullable(),
  errorCode: z.string().regex(/^[A-Z0-9_-]{1,64}$/).nullable(), at: z.iso.datetime(),
}).strict().refine((exit) => exit.kind === "launch-failed"
  ? exit.errorCode !== null && exit.code === null && exit.signal === null
  : exit.errorCode === null && ((exit.code !== null) !== (exit.signal !== null))
    && (exit.kind !== "clean" || exit.code === 0)
    && (exit.kind !== "crash" || exit.code !== 0), "Invalid supervisor exit kind")
const attemptSchema = z.object({
  number: count, startedAt: z.iso.datetime(), child: guestProcessIdentitySchema.nullable(),
  exit: exitSchema.nullable(), backoffMs: z.union([z.literal(0), z.literal(1000), z.literal(5000), z.literal(15000)]),
  backoffEndedAt: z.iso.datetime().nullable(), backoffOutcome: z.enum(["completed", "cancelled"]).nullable(),
}).strict()
export const supervisorRecordSchema = z.object({
  version: z.literal(1), supervisorId: z.uuid(), registrationId: z.uuid(),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), loop: guestProcessIdentitySchema,
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  state: z.enum(["starting", "running", "backoff", "stopping", "stopped", "exhausted", "failed"]),
  attemptCount: count, crashes: count, attempts: z.array(attemptSchema).max(4),
  reason: z.object({ kind: z.enum(["clean-exit", "deliberate-stop", "restart-limit", "observation-failure"]), at: z.iso.datetime() }).strict().nullable(),
}).strict().refine((record) => {
  if (record.attemptCount !== record.attempts.length
    || record.crashes !== record.attempts.filter((attempt) => isCrash(attempt.exit)).length) return false
  if (!record.attempts.every((attempt, index) => attempt.number === index + 1
    && (index === record.attempts.length - 1 || attempt.exit !== null)
    && (attempt.backoffMs === 0 || (isCrash(attempt.exit) && attempt.backoffMs === supervisorBackoffs[index]))
    && ((attempt.backoffEndedAt === null) === (attempt.backoffOutcome === null))
    && (attempt.backoffMs !== 0 || attempt.backoffOutcome === null)
    && (index === record.attempts.length - 1 || attempt.backoffOutcome === "completed")
    && (attempt.exit === null || attempt.exit.kind === "launch-failed" || attempt.child !== null)
    && (attempt.exit?.kind !== "launch-failed" || attempt.child === null))) return false
  const last = record.attempts.at(-1)
  if (record.state === "running" && (!last?.child || last.exit !== null)) return false
  if (record.state === "backoff" && (!last || !isCrash(last.exit) || last.backoffMs === 0)) return false
  if (record.state === "exhausted" && (record.crashes !== 4 || record.reason?.kind !== "restart-limit")) return false
  if (record.state === "failed" && record.reason?.kind !== "observation-failure") return false
  if (record.state === "stopped" && record.reason?.kind !== "clean-exit" && record.reason?.kind !== "deliberate-stop") return false
  if (record.reason?.kind === "clean-exit" && last?.exit?.kind !== "clean") return false
  if (["stopped", "exhausted", "failed"].includes(record.state)) {
    if (record.reason === null || (last && last.exit === null)) return false
  } else if (record.reason !== null) return false
  return true
}, "Supervisor record counters or state disagree with attempts")
export type SupervisorRecord = z.infer<typeof supervisorRecordSchema>
export type SupervisorExit = z.infer<typeof exitSchema>
export function isCrash(exit: SupervisorExit | null): boolean {
  return exit?.kind === "crash" || exit?.kind === "launch-failed"
}

export const supervisorRecordPath = (home: string): string => join(home, ".domovoi", "supervisor.json")
export const supervisorStopPath = (home: string): string => join(home, ".domovoi", "supervisor-stop.json")
export const supervisorStopSchema = z.object({
  version: z.literal(1), supervisorId: z.uuid(), registrationId: z.uuid(), loop: guestProcessIdentitySchema,
}).strict()

function assertPrivate(path: string, directory: boolean): void {
  const info = lstatSync(path)
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
    throw new Error("Supervisor metadata requires an owned private directory and regular files")
  }
}

export function prepareSupervisorDirectory(home: string): void {
  const directory = join(home, ".domovoi")
  mkdirSync(directory, { mode: 0o700, recursive: true })
  assertPrivate(directory, true)
}

function publish(home: string, path: string, value: unknown): void {
  const text = JSON.stringify(value) + "\n"
  if (Buffer.byteLength(text) > maximumRecordBytes) throw new Error("Supervisor record exceeds its byte limit")
  prepareSupervisorDirectory(home)
  try { assertPrivate(path, false) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const staging = path + "." + randomUUID() + ".partial"
  let failure: unknown
  try {
    writeFileSync(staging, text, { mode: 0o600, flag: "wx" })
    renameSync(staging, path)
  } catch (error) { failure = error }
  let cleanup: { error: unknown } | undefined
  try { rmSync(staging, { force: true }) } catch (error) { cleanup = { error } }
  if (cleanup !== undefined) {
    if (failure !== undefined) throw new AggregateError([failure, cleanup.error], "Supervisor publication and staging cleanup failed", { cause: failure })
    throw cleanup.error
  }
  if (failure !== undefined) throw failure
}

export function writeSupervisorRecord(home: string, record: SupervisorRecord): void {
  publish(home, supervisorRecordPath(home), supervisorRecordSchema.parse(record))
}

export function readSupervisorRecord(home: string): SupervisorRecord | undefined {
  try {
    assertPrivate(join(home, ".domovoi"), true)
    return supervisorRecordSchema.parse(JSON.parse(readLocalProfileFile(supervisorRecordPath(home), maximumRecordBytes)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    // eslint-disable-next-line preserve-caught-error -- Corrupt metadata and parser diagnostics may contain secrets.
    throw new Error("Supervisor record is invalid or inaccessible")
  }
}

export function writeSupervisorStopRequest(home: string, record: SupervisorRecord): void {
  publish(home, supervisorStopPath(home), supervisorStopSchema.parse({ version: 1,
    supervisorId: record.supervisorId, registrationId: record.registrationId, loop: record.loop }))
}

export function readSupervisorStopRequest(home: string): z.infer<typeof supervisorStopSchema> | undefined {
  try { return supervisorStopSchema.parse(JSON.parse(readLocalProfileFile(supervisorStopPath(home), 4096))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    // eslint-disable-next-line preserve-caught-error -- Never echo untrusted stop-file contents.
    throw new Error("Supervisor stop request is invalid or inaccessible")
  }
}
