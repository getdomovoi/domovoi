import { z } from "zod"

import { clientKindSchema } from "./schema.js"
import { transferMethodSchema } from "./transfer.js"
import {
  maximumTransferBytes,
  transferChunkSchema,
  transferStreamRefusalSchema,
} from "./transfer-stream.js"

export { maximumTransferBytes }

export const transferIdSchema = z.string().regex(/^transfer-[0-9a-f]{32}$/)

// The target is told what is coming before any bytes arrive, so it can refuse a
// transfer it will not take rather than discovering that halfway through.
export const transferBeginParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  sourceMachineId: z.string().regex(/^machine-[0-9a-f]{32}$/),
  method: transferMethodSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  totalBytes: z.number().int().min(1).max(maximumTransferBytes),
  client: clientKindSchema,
}).strict()

export const transferBeginResultSchema = z.object({
  transferId: transferIdSchema,
}).strict()

export const transferChunkParamsSchema = transferChunkSchema.extend({
  transferId: transferIdSchema,
  client: clientKindSchema,
}).strict()

export const transferChunkResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("receiving") }).strict(),
  // A completed transfer is only reported once the target has restored it, so
  // the source never learns a session moved before it actually did.
  z.object({
    state: z.literal("restored"),
    workspacePath: z.string().min(1),
    checkpointCommit: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict(),
  z.object({
    state: z.literal("refused"),
    reason: transferStreamRefusalSchema,
  }).strict(),
])

export type TransferBeginParams = z.infer<typeof transferBeginParamsSchema>
export type TransferBeginResult = z.infer<typeof transferBeginResultSchema>
export type TransferChunkParams = z.infer<typeof transferChunkParamsSchema>
export type TransferChunkResult = z.infer<typeof transferChunkResultSchema>
