import { z } from "zod"

import { commitShaSchema, machineIdSchema } from "./identifiers.js"
import { clientKindSchema } from "./schema.js"
import { sourceRefusalMessage, sourceRefusalSchema, transferMethodSchema, type SourceRefusal } from "./transfer.js"
import { transferRefusalMessage, transferRefusalSchema, type TransferRefusal } from "./transfer-preflight.js"
import {
  transferStreamRefusalMessage,
  transferStreamRefusalSchema,
  type TransferStreamRefusal,
} from "./transfer-stream.js"

// A remote name reaches git, where a leading dash would be read as an option.
export const gitRemoteNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(128)

export const sessionTransferParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  targetMachineId: machineIdSchema,
  client: clientKindSchema,
  // The bundle keeps repository bytes on the machines involved, so it is what
  // happens unless the caller deliberately asks for the remote.
  method: transferMethodSchema.default("git-bundle"),
  remote: gitRemoteNameSchema.optional(),
}).strict().superRefine((params, context) => {
  if (params.method === "remote-ref" && params.remote === undefined) {
    context.addIssue({
      code: "custom",
      path: ["remote"],
      message: "The remote ref path needs the remote to push to",
    })
  }
  if (params.method === "git-bundle" && params.remote !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["remote"],
      message: "A bundle transfer does not use a remote",
    })
  }
})

export const transferFromRefParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  remote: gitRemoteNameSchema,
  client: clientKindSchema,
}).strict()

export const transferFromRefResultSchema = z.object({
  workspacePath: z.string().min(1),
  checkpointCommit: commitShaSchema,
}).strict()

export const sessionTransferResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("succeeded"),
    workspacePath: z.string().min(1),
    checkpointCommit: commitShaSchema,
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
export type TransferFromRefParams = z.infer<typeof transferFromRefParamsSchema>
export type TransferFromRefResult = z.infer<typeof transferFromRefResultSchema>

export type SessionTransferRefusal = TransferRefusal | SourceRefusal | TransferStreamRefusal

const sessionTransferRefusalMessages: Record<SessionTransferRefusal, string> = {
  ...transferRefusalMessage,
  ...sourceRefusalMessage,
  ...transferStreamRefusalMessage,
}

// A refused move is only useful if it says what to do next, so the reason the
// daemon answered with is carried through to the operator verbatim.
export function sessionTransferRefusalMessage(reason: SessionTransferRefusal): string {
  return sessionTransferRefusalMessages[reason]
}
