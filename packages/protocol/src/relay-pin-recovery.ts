import { z } from "zod"

import { relayIdentityPinSchema } from "./relay-identity.js"

// Public client state. An untrusted channel never supplies its own replacement
// identity anchor; recovery keeps the anchor saved during authentic pairing.
export const relayClientPinSchema = z.object({
  version: z.literal(1),
  identity: relayIdentityPinSchema,
  state: z.enum(["trusted", "recovery-required"]),
}).strict()

export type RelayClientPin = z.infer<typeof relayClientPinSchema>
