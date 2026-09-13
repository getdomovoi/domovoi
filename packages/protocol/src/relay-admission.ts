import { z } from "zod"

import { credentialSchema } from "./identifiers.js"

// Canonical, unpadded base64url for exactly 32 bytes. The last character has
// two zero padding bits, so alternate textual encodings cannot alias a key.
export const relayBytes32Schema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
export const relayPublicKeySchema = relayBytes32Schema.refine((key) => key !== "A".repeat(43), "A relay public key cannot be zero")

export const relayChannelPinSchema = z.object({
  suite: z.literal("Noise_IK_25519_ChaChaPoly_SHA256"),
  responderPublicKey: relayPublicKeySchema,
}).strict()

// An already selected logical channel, not an advertised transport candidate.
// Endpoints, registration credentials and multiplexing belong to the carrier.
export const relayAdmissionContextSchema = z.object({
  relayProtocol: z.literal(1),
  routeId: relayBytes32Schema,
  channel: relayChannelPinSchema,
}).strict()

export const relayCredentialFrameSchema = z.object({
  kind: z.literal("credential"),
  token: credentialSchema,
}).strict()

export const relayAdmissionResultSchema = z.object({ kind: z.literal("admitted") }).strict()

export const maximumRelayFrameBytes = 65_535
export const maximumRelayAdmissionBytes = 4_096
export const maximumRelayMessageBytes = 2 * 1_024 * 1_024
export const relayRecordHeaderBytes = 9
export const maximumRelayChunkBytes = maximumRelayFrameBytes - 16 - relayRecordHeaderBytes
export const relayAdmissionTimeoutMs = 10_000
export const relayMessageTimeoutMs = 10_000
export const maximumRelayBufferedBytes = 4 * 1_024 * 1_024

export type RelayAdmissionContext = z.infer<typeof relayAdmissionContextSchema>
export type RelayChannelPin = z.infer<typeof relayChannelPinSchema>
