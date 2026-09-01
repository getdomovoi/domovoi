import { z } from "zod"

import { clientKindSchema } from "./schema.js"
import { sourceRefusalSchema } from "./transfer.js"
import { transferRefusalSchema } from "./transfer-preflight.js"
import { transferStreamRefusalSchema } from "./transfer-stream.js"

export const sessionTransferParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  targetMachineId: z.string().regex(/^machine-[0-9a-f]{32}$/),
  client: clientKindSchema,
}).strict()

export const sessionTransferResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("succeeded"),
    workspacePath: z.string().min(1),
    checkpointCommit: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict(),
  // A refusal always says why, because the answer decides what the operator
  // does next: pick another machine, or wait for a turn to finish.
  z.object({
    outcome: z.literal("refused"),
    reason: z.union([
      transferRefusalSchema,
      sourceRefusalSchema,
      transferStreamRefusalSchema,
    ]),
  }).strict(),
  z.object({ outcome: z.literal("failed") }).strict(),
])

export type SessionTransferParams = z.infer<typeof sessionTransferParamsSchema>
export type SessionTransferResult = z.infer<typeof sessionTransferResultSchema>
