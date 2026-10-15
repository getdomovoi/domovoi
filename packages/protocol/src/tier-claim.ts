import { z } from "zod"

import { machineIdSchema } from "./identifiers.js"

export const maximumTierClaimBytes = 4096
export const maximumTierClaimLifetimeSeconds = 3600
export const tierClaimAudience = "domovoi-hosted-relay-v1"
export const tierClaimCapability = "relay.connect"
export const tierClaimIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const epochSeconds = z.number().int().nonnegative().safe().refine((value) => !Object.is(value, -0))

export const tierClaimPayloadSchema = z.object({
  version: z.literal(1),
  issuer: tierClaimIdentifierSchema,
  keyId: tierClaimIdentifierSchema,
  audience: z.literal(tierClaimAudience),
  claimId: tierClaimIdentifierSchema,
  accountId: tierClaimIdentifierSchema,
  machineId: machineIdSchema,
  entitlementEpoch: z.number().int().positive().safe(),
  capability: z.literal(tierClaimCapability),
  maximumMachines: z.number().int().positive().safe(),
  issuedAt: epochSeconds,
  expiresAt: epochSeconds,
}).strict().refine(({ issuedAt, expiresAt }) => expiresAt > issuedAt
  && expiresAt - issuedAt <= maximumTierClaimLifetimeSeconds, "Invalid grant lifetime")

export const tierClaimEnvelopeSchema = z.object({
  payload: tierClaimPayloadSchema,
  // Exactly 64 bytes, unpadded base64url with zero trailing padding bits.
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
}).strict()
export type TierClaimPayload = z.infer<typeof tierClaimPayloadSchema>
export type TierClaimEnvelope = z.infer<typeof tierClaimEnvelopeSchema>

// Public input to an independent issuer; no signing key or trust source lives here.
export function tierClaimSigningBytes(value: unknown): Uint8Array {
  const p = tierClaimPayloadSchema.parse(value)
  return new TextEncoder().encode("domovoi.tier-claim.v1\n" + JSON.stringify([
    p.version, p.issuer, p.keyId, p.audience, p.claimId, p.accountId, p.machineId,
    p.entitlementEpoch, p.capability, p.maximumMachines, p.issuedAt, p.expiresAt,
  ]))
}

const malformed = () => new Error("Invalid tier claim envelope")

// This wire format needs only two levels of objects, strings and nonnegative
// decimal integers. Reading that subset before Zod preserves duplicate decoded
// names, which JSON.parse (including a reviver) would silently discard.
function parseEnvelopeText(text: string): unknown {
  let at = 0
  const space = () => { while (at < text.length && /[\x20\t\r\n]/u.test(text[at]!)) at++ }
  const take = (character: string) => {
    space()
    if (text[at] !== character) throw malformed()
    at++
  }
  const string = (): string => {
    space()
    const start = at
    if (text[at++] !== '"') throw malformed()
    while (at < text.length) {
      const character = text[at++]
      if (character === "\\") at++
      else if (character === '"') {
        const decoded: unknown = JSON.parse(text.slice(start, at))
        if (typeof decoded !== "string") throw malformed()
        return decoded
      }
    }
    throw malformed()
  }
  const value = (depth: number): unknown => {
    space()
    if (text[at] === '"') return string()
    if (text[at] === "{") return object(depth + 1)
    const start = at
    while (at < text.length && /[0-9]/u.test(text[at]!)) at++
    const token = text.slice(start, at)
    if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) throw malformed()
    const number = Number(token)
    if (!Number.isSafeInteger(number)) throw malformed()
    return number
  }
  const object = (depth: number): Record<string, unknown> => {
    if (depth > 2) throw malformed()
    take("{")
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const names = new Set<string>()
    space()
    if (text[at] !== "}") {
      for (;;) {
        const name = string()
        if (names.has(name)) throw malformed()
        names.add(name)
        take(":")
        result[name] = value(depth)
        space()
        if (text[at] !== ",") break
        at++
      }
    }
    take("}")
    return result
  }
  const result = object(1)
  space()
  if (at !== text.length) throw malformed()
  return result
}

export function parseTierClaimEnvelope(bytes: Uint8Array): TierClaimEnvelope {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumTierClaimBytes) throw malformed()
    // Preserve a BOM so it is rejected as non-JSON, rather than silently stripped.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes))
    return tierClaimEnvelopeSchema.parse(parseEnvelopeText(text))
  } catch { throw malformed() }
}
