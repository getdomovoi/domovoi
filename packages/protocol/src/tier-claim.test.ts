import { describe, expect, it } from "vitest"

import { maximumTierClaimBytes, parseTierClaimEnvelope, tierClaimPayloadSchema, tierClaimSigningBytes } from "./tier-claim.js"

const payload = { version: 1, issuer: "issuer-test", keyId: "key-1", audience: "domovoi-hosted-relay-v1",
  claimId: "claim-1", accountId: "account-1", machineId: `machine-${"a".repeat(32)}`,
  entitlementEpoch: 2, capability: "relay.connect", maximumMachines: 3, issuedAt: 1700000000, expiresAt: 1700003600 }
const signature = "A".repeat(86)
const encode = (text: string) => new TextEncoder().encode(text)
const envelope = JSON.stringify({ payload, signature })

describe("tier claim raw envelope", () => {
  it("accepts a structurally valid envelope without claiming its signature is verified", () => {
    expect(parseTierClaimEnvelope(encode(envelope))).toEqual({ payload, signature })
  })

  it.each([
    envelope.replace('"version":1', '"version":1,"version":1'),
    envelope.replace('"keyId":"key-1"', '"keyId":"key-1","\\u006beyId":"key-1"'),
    envelope.replace('"signature":', '"signature":"' + signature + '","signature":'),
  ])("refuses duplicate decoded JSON members", (text) => {
    expect(() => parseTierClaimEnvelope(encode(text))).toThrow()
  })

  it("refuses oversized bytes before parsing even when only whitespace exceeds the budget", () => {
    expect(() => parseTierClaimEnvelope(encode(envelope.padEnd(4097)))).toThrow()
  })

  it("refuses unknown envelope fields", () => {
    expect(() => parseTierClaimEnvelope(encode(JSON.stringify({ payload, signature, verified: true })))).toThrow()
  })

  it("accepts exactly the byte bound and rejects malformed UTF-8 and a BOM", () => {
    expect(parseTierClaimEnvelope(encode(envelope.padEnd(maximumTierClaimBytes)))).toEqual({ payload, signature })
    for (const bytes of [new Uint8Array(), new Uint8Array([0xc0, 0xaf]), encode("\ufeff" + envelope)]) {
      expect(() => parseTierClaimEnvelope(bytes)).toThrow("Invalid tier claim envelope")
    }
    expect(() => parseTierClaimEnvelope(envelope as unknown as Uint8Array)).toThrow()
  })

  it.each(["-0", "1.0", "1e0", "01", "9007199254740992", "null", "true", "[]", '{"nested":{"deep":1}}'])("refuses noncanonical or non-scalar version %s", (token) => {
    expect(() => parseTierClaimEnvelope(encode(envelope.replace('"version":1', `"version":${token}`)))).toThrow()
  })

  it.each(["", "null", "[]", "{", '{"payload":', envelope + "false", envelope.replace('"payload":', '"payload" '),
    envelope.replace('"issuer-test"', '"issuer\n-test"'), envelope.replace('"issuer-test"', '"issuer\\x-test"'),
    envelope.replace('"issuer-test"', '"unfinished\\'), envelope.replace('"payload":', '"payload":,'),
    envelope.replace('"signature":', '"__proto__":{},"signature":'), envelope.replace(/}$/, ",}"), "{}"])("refuses invalid JSON or incomplete/extra fields", (text) => {
    expect(() => parseTierClaimEnvelope(encode(text))).toThrow("Invalid tier claim envelope")
  })

  it("accepts JSON whitespace and escapes without changing signed semantics", () => {
    const text = envelope.replace('"issuer-test"', '"issuer\\u002dtest"').replace('"keyId"', '"\\u006beyId"')
    expect(parseTierClaimEnvelope(encode("\r\n\t " + text + " \n"))).toEqual({ payload, signature })
  })

  it.each([signature + "=", "A".repeat(85) + "B", "A".repeat(85), "A".repeat(87), "+" + signature.slice(1)])("refuses noncanonical signature %s", (value) => {
    expect(() => parseTierClaimEnvelope(encode(JSON.stringify({ payload, signature: value })))).toThrow()
  })
})

describe("tier claim signing contract", () => {
  it("pins literal signing bytes independently of serializer field ordering", () => {
    const expected = 'domovoi.tier-claim.v1\n[1,"issuer-test","key-1","domovoi-hosted-relay-v1","claim-1","account-1","machine-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",2,"relay.connect",3,1700000000,1700003600]'
    expect(tierClaimSigningBytes(payload)).toEqual(encode(expected))
    const reversed = Object.fromEntries(Object.entries(payload).reverse())
    expect(tierClaimSigningBytes(reversed)).toEqual(encode(expected))
  })

  it.each([
    { version: 2 }, { issuer: " space" }, { issuer: "é" }, { keyId: "" }, { claimId: "a".repeat(129) },
    { accountId: "__proto__" }, { machineId: "machine-other" }, { audience: "terminal" }, { capability: "terminal.open" },
    { entitlementEpoch: 0 }, { maximumMachines: 0 }, { maximumMachines: Number.MAX_SAFE_INTEGER + 1 },
    { issuedAt: -0 }, { issuedAt: -1 }, { issuedAt: 1.5 }, { expiresAt: Infinity },
    { expiresAt: payload.issuedAt }, { expiresAt: payload.expiresAt + 1 }, { expiresAt: payload.issuedAt - 1 }, { verified: true },
  ])("refuses invalid payload fields %j", (change) => {
    expect(() => tierClaimSigningBytes({ ...payload, ...change })).toThrow()
    expect(() => parseTierClaimEnvelope(encode(JSON.stringify({ payload: { ...payload, ...change }, signature })))).toThrow()
  })

  it("validates bounded ASCII identifiers and safe upper-bound arithmetic", () => {
    expect(tierClaimPayloadSchema.parse({ ...payload, issuer: "A.:_-9", keyId: "z".repeat(128),
      maximumMachines: Number.MAX_SAFE_INTEGER, entitlementEpoch: Number.MAX_SAFE_INTEGER,
      issuedAt: Number.MAX_SAFE_INTEGER - 3600, expiresAt: Number.MAX_SAFE_INTEGER })).toBeDefined()
  })
})
