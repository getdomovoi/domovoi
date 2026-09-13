import { z } from "zod"

import { machineIdSchema } from "./identifiers.js"
import { relayIdentityPinSchema, relaySignedSuccessorSchema } from "./relay-identity.js"

export const maximumRelayRecoveryBytes = 2_048

// Fetch precedes admission deliberately: the old channel pin may no longer
// work. Trust comes from the cold identity signature checked against the saved
// pin, never from this fetch or the identity returned by it. No bearer belongs here.
export const relayRecoveryParamsSchema = z.object({ machineId: machineIdSchema }).strict()

export const relayRecoveryResultSchema = z.object({
  identity: relayIdentityPinSchema,
  successor: relaySignedSuccessorSchema.optional(),
}).strict().superRefine(({ identity, successor }, context) => {
  const statement = successor?.statement
  if (identity.generation === 1 ? successor !== undefined : statement === undefined
    || statement.generation !== identity.generation
    || statement.machineId !== identity.machineId
    || statement.identityPublicKey !== identity.identityPublicKey
    || statement.channel.suite !== identity.channel.suite
    || statement.channel.responderPublicKey !== identity.channel.responderPublicKey) {
    context.addIssue({ code: "custom", message: "The latest successor must match the published identity" })
  }
}).refine((value) => JSON.stringify(value).length <= maximumRelayRecoveryBytes, "Relay recovery publication exceeds its byte limit")

export type RelayRecoveryParams = z.infer<typeof relayRecoveryParamsSchema>
export type RelayRecoveryResult = z.infer<typeof relayRecoveryResultSchema>
