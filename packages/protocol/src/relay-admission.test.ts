import { describe, expect, it } from "vitest"

import { deviceClaimParamsSchema, deviceClaimResultSchema, devicePairParamsSchema, devicePairResultSchema } from "./devices.js"
import { relayAdmissionContextSchema, relayBytes32Schema, relayPublicKeySchema, relayCredentialFrameSchema, relayAdmissionResultSchema } from "./relay-admission.js"
import { protocolVersion } from "./protocol-version.js"

const publicKey = Buffer.alloc(32, 11).toString("base64url")
const channel = { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: Buffer.alloc(32, 12).toString("base64url") }

describe("paired relay channel keys", () => {
  it("accepts an explicit channel key at direct client pairing", () => {
    expect(devicePairParamsSchema.parse({ label: "phone", client: "phone", channelPublicKey: publicKey }))
      .toMatchObject({ channelPublicKey: publicKey })
  })

  it("returns the daemon pin with the one-time credential without changing device summaries", () => {
    expect(devicePairResultSchema.parse({
      device: { id: `device-${"a".repeat(32)}`, label: "phone", pairedAt: "2026-09-13T00:00:00Z",
        binding: { kind: "client", client: "phone" } },
      token: "t".repeat(43), relay: channel,
    })).toMatchObject({ relay: channel })
  })

  it("carries the selected key into a pending machine claim", () => {
    expect(deviceClaimParamsSchema.parse({ code: "maple-lake-cloud-42", label: "machine",
      machineId: `machine-${"b".repeat(32)}`, protocolVersion, channelPublicKey: publicKey }))
      .toMatchObject({ channelPublicKey: publicKey })
  })

  it("returns a daemon pin while the machine claim remains pending", () => {
    expect(deviceClaimResultSchema.parse({
      claim: { state: "pending", deviceId: `device-${"a".repeat(32)}`, machineId: `machine-${"b".repeat(32)}`,
        expiresAt: "2026-09-13T00:00:00Z" },
      token: "t".repeat(43),
      machine: { id: `machine-${"c".repeat(32)}`, label: "target", platform: "linux", arch: "x64",
        version: "0.0.1", protocolVersion, capabilities: [], transports: [] },
      relay: channel,
    })).toMatchObject({ relay: channel })
  })
})


describe("relay admission wire validation", () => {
  it.each(["", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "B", "a".repeat(42) + "=", "a".repeat(42) + "/", "🙂".repeat(43)])("rejects noncanonical 32-byte value %s", (value) => {
    expect(relayBytes32Schema.safeParse(value).success).toBe(false)
  })
  it("allows a zero route identifier but never a zero public key", () => {
    expect(relayBytes32Schema.parse("A".repeat(43))).toBe("A".repeat(43))
    expect(relayPublicKeySchema.safeParse("A".repeat(43)).success).toBe(false)
  })
  it.each([
    { relayProtocol: 2, routeId: publicKey, channel },
    { relayProtocol: 1, routeId: publicKey, channel: { ...channel, suite: "Noise_IK_P256_AESGCM_SHA256" } },
    { relayProtocol: 1, routeId: publicKey, channel: { ...channel, registration: "secret" } },
    { relayProtocol: 1, routeId: publicKey, channel, endpoint: "wss://untrusted.invalid" },
  ])("refuses unsupported context fields and suites", (input) => {
    expect(relayAdmissionContextSchema.safeParse(input).success).toBe(false)
  })
  it("keeps credential and receipt shapes strict", () => {
    expect(relayCredentialFrameSchema.safeParse({ kind: "credential", token: "t".repeat(43), deviceId: "claimed" }).success).toBe(false)
    expect(relayAdmissionResultSchema.safeParse({ kind: "admitted", root: true }).success).toBe(false)
    expect(relayAdmissionContextSchema.parse({ relayProtocol: 1, routeId: publicKey, channel })).toEqual({ relayProtocol: 1, routeId: publicKey, channel })
  })
})
