import { generateKeyPairSync, sign } from "node:crypto"

import { tierClaimSigningBytes, type TierClaimPayload } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { verifyTierClaim } from "./tier-claim.js"

const key = generateKeyPairSync("ed25519")
const other = generateKeyPairSync("ed25519")
const publicKey = key.publicKey.export({ format: "jwk" }).x!
const payload: TierClaimPayload = { version: 1, issuer: "issuer-test", keyId: "key-1", audience: "domovoi-hosted-relay-v1",
  claimId: "claim-1", accountId: "account-1", machineId: `machine-${"a".repeat(32)}`, entitlementEpoch: 2,
  capability: "relay.connect", maximumMachines: 3, issuedAt: 1700000000, expiresAt: 1700003600 }
const context = { issuer: payload.issuer, audience: payload.audience, accountId: payload.accountId, machineId: payload.machineId,
  now: payload.issuedAt, maximumLifetimeSeconds: 3600, minimumEntitlementEpoch: 2,
  keys: [{ keyId: payload.keyId, publicKey, notBefore: payload.issuedAt, notAfter: payload.expiresAt }] }
function signed(value = payload, signer = key.privateKey): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ payload: value,
    signature: sign(null, tierClaimSigningBytes(value), signer).toString("base64url") }))
}

describe("pure hosted relay entitlement verifier", () => {
  it("accepts the exact signed binding at issuance under independently supplied expectations", () => {
    expect(verifyTierClaim(signed(), context)).toEqual({ status: "eligible", claim: payload })
  })

  it("verifies the independent literal message vector, refusing object JSON and another domain", () => {
    const literal = 'domovoi.tier-claim.v1\n[1,"issuer-test","key-1","domovoi-hosted-relay-v1","claim-1","account-1","machine-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",2,"relay.connect",3,1700000000,1700003600]'
    const encoded = (message: string) => new TextEncoder().encode(JSON.stringify({ payload,
      signature: sign(null, Buffer.from(message), key.privateKey).toString("base64url") }))
    expect(verifyTierClaim(encoded(literal), context)).toEqual({ status: "eligible", claim: payload })
    for (const message of [JSON.stringify(payload), literal.replace("tier-claim", "relay-channel-successor"), literal + "\n"]) {
      expect(verifyTierClaim(encoded(message), context)).toEqual({ status: "refused", reason: "invalid-signature" })
    }
  })

  it.each(["issuer", "audience", "accountId", "machineId", "now", "maximumLifetimeSeconds", "minimumEntitlementEpoch", "keys"])("does not grant eligibility without trusted %s", (field) => {
    const missing: Record<string, unknown> = { ...context }
    delete missing[field]
    expect(verifyTierClaim(signed(), missing)).toEqual({ status: "unavailable", reason: "invalid-context" })
  })

  it.each([
    { issuer: "other-issuer" }, { accountId: "other-account" }, { machineId: `machine-${"b".repeat(32)}` },
  ])("refuses a correctly signed grant for another expected scope %j", (change) => {
    expect(verifyTierClaim(signed(), { ...context, ...change })).toEqual({ status: "refused", reason: "binding-mismatch" })
  })

  it("refuses unknown and wrong signers, changed payloads and malformed raw envelopes", () => {
    expect(verifyTierClaim(signed(), { ...context, keys: [{ ...context.keys[0], keyId: "different" }] }))
      .toEqual({ status: "refused", reason: "unknown-signer" })
    expect(verifyTierClaim(signed(payload, other.privateKey), context)).toEqual({ status: "refused", reason: "invalid-signature" })
    const bytes = new TextDecoder().decode(signed()).replace('"maximumMachines":3', '"maximumMachines":4')
    expect(verifyTierClaim(new TextEncoder().encode(bytes), context)).toEqual({ status: "refused", reason: "invalid-signature" })
    expect(verifyTierClaim(new Uint8Array([255]), context)).toEqual({ status: "refused", reason: "invalid-envelope" })
    expect(verifyTierClaim(new TextEncoder().encode(new TextDecoder().decode(signed()).replace('"version":1', '"version":1,"version":1')), context))
      .toEqual({ status: "refused", reason: "invalid-envelope" })
  })

  it.each([payload.issuedAt - 1, payload.expiresAt, payload.expiresAt + 1])("refuses outside exact grant time %s", (now) => {
    const wide = { ...context, now, keys: [{ ...context.keys[0], notBefore: 0, notAfter: payload.expiresAt + 100 }] }
    expect(verifyTierClaim(signed(), wide)).toEqual({ status: "refused", reason: "claim-time" })
  })

  it("respects a narrower lifetime cap and rejects an older epoch", () => {
    expect(verifyTierClaim(signed(), { ...context, maximumLifetimeSeconds: 3599 })).toEqual({ status: "refused", reason: "claim-lifetime" })
    expect(verifyTierClaim(signed(), { ...context, minimumEntitlementEpoch: 3 })).toEqual({ status: "refused", reason: "stale-epoch" })
  })

  it.each([
    { notBefore: payload.issuedAt + 1 }, { notAfter: payload.expiresAt - 1 }, { notAfter: payload.issuedAt },
  ])("refuses grant or observation outside trusted key window %j", (change) => {
    const trusted = { ...context.keys[0], notBefore: payload.issuedAt - 100, ...change }
    expect(verifyTierClaim(signed(), { ...context, keys: [trusted] })).toEqual({ status: "refused", reason: "key-time" })
  })

  it("refuses a retired key even for a backdated signed claim still inside its old window", () => {
    expect(verifyTierClaim(signed(), { ...context, now: payload.expiresAt })).toEqual({ status: "refused", reason: "key-time" })
  })

  it.each([undefined, null, {}, { ...context, keys: [] }, { ...context, now: NaN }, { ...context, now: -0 },
    { ...context, now: Infinity }, { ...context, maximumLifetimeSeconds: 3601 }, { ...context, minimumEntitlementEpoch: 0 },
    { ...context, keys: [context.keys[0], context.keys[0]] }, { ...context, keys: Array(65).fill(context.keys[0]) },
    { ...context, audience: "terminal" }, { ...context, verified: true }])("fails unavailable for invalid trusted context", (trusted) => {
    expect(verifyTierClaim(signed(), trusted)).toEqual({ status: "unavailable", reason: "invalid-context" })
  })

  it.each([
    { publicKey: "A".repeat(43) }, { publicKey: "A".repeat(42) + "B" },
    { publicKey: Buffer.from([1, ...new Uint8Array(31)]).toString("base64url") },
    { notBefore: undefined }, { notAfter: undefined }, { notBefore: 1.5 }, { notBefore: -0 },
    { notAfter: payload.issuedAt }, { notAfter: Number.MAX_SAFE_INTEGER + 1 }, { algorithm: "rsa" },
  ])("refuses malformed trusted key %j", (change) => {
    expect(verifyTierClaim(signed(), { ...context, keys: [{ ...context.keys[0], ...change }] }))
      .toEqual({ status: "unavailable", reason: "invalid-context" })
  })

  it("demonstrates the offline revocation limit without claiming live registry status", () => {
    const grant = signed()
    expect(verifyTierClaim(grant, { ...context, now: payload.expiresAt - 1 }).status).toBe("eligible")
    expect(verifyTierClaim(grant, { ...context, now: payload.expiresAt - 1, minimumEntitlementEpoch: 3 }).status).toBe("refused")
    expect(verifyTierClaim(grant, { ...context, now: payload.expiresAt }).status).toBe("refused")
  })

  it("honors overlap only through each independently trusted key window and does not mutate context", () => {
    const original = structuredClone(context)
    const rotated = { ...payload, keyId: "key-2" }
    const trusted = { ...context, keys: [...context.keys,
      { ...context.keys[0], keyId: "key-2", publicKey: other.publicKey.export({ format: "jwk" }).x! }] }
    expect(verifyTierClaim(signed(rotated, other.privateKey), trusted)).toEqual({ status: "eligible", claim: rotated })
    expect(verifyTierClaim(signed(rotated, other.privateKey), context).status).toBe("refused")
    expect(context).toEqual(original)
  })

  it("does not promote claim-supplied trust or silently repair missing context", () => {
    const injection = new TextEncoder().encode(JSON.stringify({ payload, signature: "A".repeat(86), keys: context.keys, now: context.now }))
    expect(verifyTierClaim(injection, context)).toEqual({ status: "refused", reason: "invalid-envelope" })
    expect(verifyTierClaim(signed(), { ...context, keys: [{ keyId: "key-1", publicKey }] }))
      .toEqual({ status: "unavailable", reason: "invalid-context" })
  })
})
