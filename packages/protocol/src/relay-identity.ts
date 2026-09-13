import { z } from "zod"

import { machineIdSchema } from "./identifiers.js"
import { relayChannelPinSchema, relayPublicKeySchema } from "./relay-admission.js"

// The identity private key is kept off the machine whose channel it authorizes.
// These records deliberately accept only public keys and an external signature.
export const relayIdentityPinSchema = z.object({
  version: z.literal(1),
  machineId: machineIdSchema,
  identityPublicKey: relayPublicKeySchema,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  channel: relayChannelPinSchema,
}).strict()

export const relaySuccessorStatementSchema = z.object({
  version: z.literal(1),
  machineId: machineIdSchema,
  identityPublicKey: relayPublicKeySchema,
  generation: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  previousChannelPublicKey: relayPublicKeySchema,
  channel: relayChannelPinSchema,
}).strict()

export const relaySignedSuccessorSchema = z.object({
  statement: relaySuccessorStatementSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
}).strict()

export type RelayIdentityPin = z.infer<typeof relayIdentityPinSchema>
export type RelaySuccessorStatement = z.infer<typeof relaySuccessorStatementSchema>
export type RelaySignedSuccessor = z.infer<typeof relaySignedSuccessorSchema>
