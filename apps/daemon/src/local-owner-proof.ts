import { createHmac, timingSafeEqual } from "node:crypto"

import { credentialSchema, machineIdSchema } from "@getdomovoi/protocol"
import { z } from "zod"

// Loaded from a dedicated owner-only profile secret, never the daemon bearer.
// A plain authToken cannot be passed here without explicitly defeating the type.
export const localOwnerSecretSchema = credentialSchema.brand<"LocalOwnerSecret">()
export type LocalOwnerSecret = z.infer<typeof localOwnerSecretSchema>

export const localOwnerIdentitySchema = z.object({
  instanceId: z.uuid(),
  machineId: machineIdSchema,
  protocolVersion: z.string().max(64).regex(/^\d+\.\d+\.\d+$/),
}).strict()
export type LocalOwnerIdentity = z.infer<typeof localOwnerIdentitySchema>

export function localOwnerProof(secret: LocalOwnerSecret, identity: LocalOwnerIdentity, nonce: string): string {
  localOwnerIdentitySchema.parse({ instanceId: identity.instanceId, machineId: identity.machineId, protocolVersion: identity.protocolVersion })
  credentialSchema.parse(nonce)
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(JSON.stringify([
      "domovoi.local-owner.v1", identity.instanceId, identity.machineId, identity.protocolVersion, nonce,
    ]))
    .digest("base64url")
}

export function verifyLocalOwnerProof(
  secret: LocalOwnerSecret, identity: LocalOwnerIdentity, nonce: string, proof: unknown,
): boolean {
  const parsed = credentialSchema.safeParse(proof)
  if (!parsed.success) return false
  const expected = Buffer.from(localOwnerProof(secret, identity, nonce), "base64url")
  const actual = Buffer.from(parsed.data, "base64url")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
