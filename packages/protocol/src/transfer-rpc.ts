import { z } from "zod"

import { commitShaSchema, machineIdSchema } from "./identifiers.js"
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
  sourceMachineId: machineIdSchema,
  method: transferMethodSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  totalBytes: z.number().int().min(1).max(maximumTransferBytes),
  client: clientKindSchema,
  // Named when the bundle starts from a commit the target reported holding, so
  // a move carries what is missing rather than the whole history again.
  sinceCommit: commitShaSchema.optional(),
}).strict()

export const transferBeginResultSchema = z.object({
  transferId: transferIdSchema,
  // What the target already has for this session, if anything. A source can
  // bundle from it instead of from the beginning.
  haveCommit: commitShaSchema.optional(),
}).strict()

// Asked before a bundle is built: what does the target already have for this
// session? Nothing here identifies content, only a commit both sides can name.
export const transferHaveParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  client: clientKindSchema,
}).strict()

export const transferHaveResultSchema = z.object({
  commit: commitShaSchema.optional(),
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
    checkpointCommit: commitShaSchema,
  }).strict(),
  z.object({
    state: z.literal("refused"),
    reason: transferStreamRefusalSchema,
  }).strict(),
])

export type TransferBeginParams = z.infer<typeof transferBeginParamsSchema>
export type TransferBeginResult = z.infer<typeof transferBeginResultSchema>
export type TransferHaveParams = z.infer<typeof transferHaveParamsSchema>
export type TransferHaveResult = z.infer<typeof transferHaveResultSchema>
export type TransferChunkParams = z.infer<typeof transferChunkParamsSchema>
export type TransferChunkResult = z.infer<typeof transferChunkResultSchema>
