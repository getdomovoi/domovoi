import { randomUUID } from "node:crypto"
import { lstatSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { isAbsolute } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import { z } from "zod"

import { claimExclusiveFileLease } from "./file-lease.js"
import { readLocalProfileFile } from "./local-owner-record.js"

const recordSchema = z.object({
  version: z.literal(1), binding: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()

export type RelayGeneration = { next(): Promise<number>; close(): Promise<void> }
// The operator initializes this record with the relay's known floor. Missing
// state is never evidence that zero is safe. Keep the exclusive owner through
// pending publication, including stop, and burn every uncertain reservation.
export function openRelayGeneration(path: string, binding: string, publish = publishFileDurably): RelayGeneration {
  if (!isAbsolute(path) || path.length > 4096 || !/^[a-f0-9]{64}$/.test(binding)) throw new Error("Invalid relay generation binding")
  const lease = claimExclusiveFileLease(`${path}.owner.sqlite`, () => new Error("Relay generation is already owned"))
  let generation: number
  try {
    if (!lstatSync(path).isFile()) throw new Error("Relay generation must be a regular file")
    const record = recordSchema.parse(JSON.parse(readLocalProfileFile(path, 2048)))
    if (record.binding !== binding) throw new Error("Relay generation binding changed")
    generation = record.generation
  } catch {
    lease.release()
    // Corrupt local records may contain credentials; do not expose parser details.
    throw new Error("Relay generation state is missing, invalid or belongs to another registration")
  }
  let pending = Promise.resolve()
  let stopped = false
  let failed = false
  return {
    next() {
      if (stopped) return Promise.reject(new Error("Relay generation owner is closed"))
      const result = pending.then(async () => {
        if (failed || generation === Number.MAX_SAFE_INTEGER) throw new Error("Relay generation cannot advance")
        const reserved = generation + 1
        const staging = `${path}.${randomUUID()}.partial`
        try {
          await writeFile(staging, JSON.stringify({ version: 1, binding, generation: reserved }), { flag: "wx", mode: 0o600, flush: true })
          await publish(staging, path)
          generation = reserved
          return reserved
        } catch (error) {
          failed = true
          throw error
        } finally { await rm(staging, { force: true }) }
      })
      pending = result.then(() => {}, () => {})
      return result
    },
    async close() { stopped = true; await pending; lease.release() },
  }
}
