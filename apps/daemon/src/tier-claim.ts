import { createPublicKey, verify } from "node:crypto"

import {
  machineIdSchema, maximumTierClaimLifetimeSeconds, parseTierClaimEnvelope, relayBytes32Schema,
  tierClaimAudience, tierClaimIdentifierSchema, tierClaimSigningBytes, type TierClaimPayload,
} from "@getdomovoi/protocol"
import { relayIdentityPublicKeyIsValid } from "@getdomovoi/protocol/relay-admission"
import { z } from "zod"

const seconds = z.number().int().nonnegative().safe().refine((value) => !Object.is(value, -0))
const trustedKeySchema = z.object({
  keyId: tierClaimIdentifierSchema,
  // Reuse only the Ed25519 point validator, never the relay identity trust store.
  publicKey: relayBytes32Schema.refine(relayIdentityPublicKeyIsValid),
  notBefore: seconds,
  notAfter: seconds,
}).strict().refine((key) => key.notBefore < key.notAfter)

const contextSchema = z.object({
  issuer: tierClaimIdentifierSchema,
  audience: z.literal(tierClaimAudience),
  accountId: tierClaimIdentifierSchema,
  machineId: machineIdSchema,
  now: seconds,
  maximumLifetimeSeconds: z.number().int().positive().max(maximumTierClaimLifetimeSeconds),
  minimumEntitlementEpoch: z.number().int().positive().safe(),
  keys: z.array(trustedKeySchema).min(1).max(64)
    .refine((keys) => new Set(keys.map((key) => key.keyId)).size === keys.length),
}).strict()

// Every member is supplied by a trusted integration. This pure function cannot
// establish clock continuity, persist an epoch floor or obtain current policy.
export type TierClaimVerificationContext = z.infer<typeof contextSchema>
export type TierClaimVerificationResult =
  | { status: "eligible"; claim: TierClaimPayload }
  | { status: "unavailable"; reason: "invalid-context" }
  | { status: "refused"; reason: "invalid-envelope" | "unknown-signer" | "invalid-signature"
    | "binding-mismatch" | "key-time" | "claim-time" | "claim-lifetime" | "stale-epoch" }

export function verifyTierClaim(bytes: Uint8Array, trusted: unknown): TierClaimVerificationResult {
  let context: TierClaimVerificationContext
  try { context = contextSchema.parse(trusted) }
  catch { return { status: "unavailable", reason: "invalid-context" } }

  let envelope: ReturnType<typeof parseTierClaimEnvelope>
  try { envelope = parseTierClaimEnvelope(bytes) }
  catch { return { status: "refused", reason: "invalid-envelope" } }
  const claim = envelope.payload
  const key = context.keys.find((candidate) => candidate.keyId === claim.keyId)
  if (!key) return { status: "refused", reason: "unknown-signer" }
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey }, format: "jwk" })
    if (!verify(null, tierClaimSigningBytes(claim), publicKey, Buffer.from(envelope.signature, "base64url"))) {
      return { status: "refused", reason: "invalid-signature" }
    }
  } catch { return { status: "refused", reason: "invalid-signature" } }

  if (claim.issuer !== context.issuer || claim.audience !== context.audience
    || claim.accountId !== context.accountId || claim.machineId !== context.machineId) {
    return { status: "refused", reason: "binding-mismatch" }
  }
  if (claim.issuedAt < key.notBefore || claim.expiresAt > key.notAfter
    || context.now < key.notBefore || context.now >= key.notAfter) return { status: "refused", reason: "key-time" }
  if (claim.issuedAt > context.now || context.now >= claim.expiresAt) return { status: "refused", reason: "claim-time" }
  if (claim.expiresAt - claim.issuedAt > context.maximumLifetimeSeconds) return { status: "refused", reason: "claim-lifetime" }
  if (claim.entitlementEpoch < context.minimumEntitlementEpoch) return { status: "refused", reason: "stale-epoch" }
  return { status: "eligible", claim }
}
