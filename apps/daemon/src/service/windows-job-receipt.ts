import { lstatSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

import { readLocalProfileFile } from "../local-owner-record.js"
import { profileDirectory, type ProfileLocation } from "../profile-directory.js"
import { windowsBootIdSchema, windowsJobNameSchema, windowsProcessIdentitySchema, windowsSupervisorRecordSchema,
  type WindowsProcessIdentity, type WindowsSupervisorRecord } from "./supervisor-record.js"

export const windowsJobReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal("empty"), job: windowsJobNameSchema, bootId: windowsBootIdSchema,
  registrationId: z.uuid(), attempt: z.number().int().min(1).max(4), at: z.iso.datetime(),
  child: windowsProcessIdentitySchema, helper: windowsProcessIdentitySchema,
  activeProcesses: z.literal(0), terminated: z.literal(true),
  code: z.number().int().min(0).max(4_294_967_295), stopped: z.boolean(),
}).strict().refine((r) => r.child.bootId === r.bootId && r.helper.bootId === r.bootId)
export type WindowsJobReceipt = z.infer<typeof windowsJobReceiptSchema>
export function windowsJobReceiptPath(home: ProfileLocation, job: string): string {
  windowsJobNameSchema.parse(job)
  return join(profileDirectory(home), `windows-job-${job.slice(14)}.receipt.json`)
}
const sameIdentity = (left: WindowsProcessIdentity | null, right: WindowsProcessIdentity) =>
  left === null || (left.pid === right.pid && left.start === right.start && left.bootId === right.bootId)

// The helper is the only production writer. It flushes a private staging file
// and atomically publishes it after querying its retained job handle. A missing
// file supplies no proof; a present but invalid file refuses, never guesses.
export function recoverWindowsJobReceipts(home: ProfileLocation, record: WindowsSupervisorRecord): WindowsSupervisorRecord {
  const recovered = structuredClone(record)
  for (const attempt of recovered.attempts) {
    if (attempt.empty) continue
    let receipt: WindowsJobReceipt
    try {
      const path = windowsJobReceiptPath(home, attempt.job)
      const info = lstatSync(path)
      if (!info.isFile() || info.nlink !== 1) throw new Error("Receipt must be a regular file")
      receipt = windowsJobReceiptSchema.parse(JSON.parse(readLocalProfileFile(path, 8192)))
      if (receipt.job !== attempt.job || receipt.bootId !== attempt.bootId || receipt.registrationId !== record.registrationId
        || receipt.attempt !== attempt.number || !sameIdentity(attempt.child, receipt.child) || !sameIdentity(attempt.helper, receipt.helper)) {
        throw new Error("Receipt binding disagrees with the launch")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      // eslint-disable-next-line preserve-caught-error -- Never echo untrusted receipt contents or parser diagnostics.
      throw new Error("Windows job receipt is invalid or inaccessible; shutdown cannot be proved")
    }
    attempt.child = receipt.child; attempt.helper = receipt.helper
    attempt.empty = { at: receipt.at, activeProcesses: 0, terminated: true }; attempt.stage = "empty"; attempt.exitCode = receipt.code
    // An independent receipt may be the only terminal publication after the
    // supervisor died. Nonzero unexpected exit still reports observation failure.
    recovered.state = receipt.stopped || receipt.code === 0 ? "stopped" : "failed"
    recovered.reason = receipt.stopped ? "deliberate-stop" : receipt.code === 0 ? "clean-exit" : "observation-failure"
  }
  return windowsSupervisorRecordSchema.parse(recovered)
}
