import { createHash, createHmac, randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  localOwnerSecretSchema, localOwnerProof, verifyLocalOwnerProof,
} from "./local-owner-proof.js"

describe("local owner challenge", () => {
  const identity = { instanceId: "d3d4cd0f-f164-4756-af41-2c8e84bb4770", machineId: `machine-${"a".repeat(32)}`, protocolVersion: "0.4.0" }
  const key = localOwnerSecretSchema.parse(createHash("sha256").update("local-owner-proof-fixture").digest("base64url"))
  const nonce = randomBytes(32).toString("base64url")

  it("binds the proof to fresh challenge, instance, machine and protocol", () => {
    const proof = localOwnerProof(key, identity, nonce)
    expect(verifyLocalOwnerProof(key, identity, nonce, proof)).toBe(true)
    expect(verifyLocalOwnerProof(key, identity, randomBytes(32).toString("base64url"), proof)).toBe(false)
    expect(verifyLocalOwnerProof(key, { ...identity, instanceId: "c3d4cd0f-f164-4756-af41-2c8e84bb4770" }, nonce, proof)).toBe(false)
    expect(verifyLocalOwnerProof(key, { ...identity, machineId: `machine-${"b".repeat(32)}` }, nonce, proof)).toBe(false)
    expect(verifyLocalOwnerProof(key, { ...identity, protocolVersion: "0.5.0" }, nonce, proof)).toBe(false)
  })

  it("uses a domain-separated HMAC and never needs the root bearer", () => {
    const proof = localOwnerProof(key, identity, nonce)
    expect(proof).toBe(createHmac("sha256", Buffer.from(key, "base64url"))
      .update(JSON.stringify(["domovoi.local-owner.v1", identity.instanceId, identity.machineId, identity.protocolVersion, nonce]))
      .digest("base64url"))
    expect(verifyLocalOwnerProof(localOwnerSecretSchema.parse("s".repeat(43)), identity, nonce, proof)).toBe(false)
    expect(proof).not.toContain(key)
  })

  it("refuses malformed proofs and unbounded challenge text", () => {
    for (const proof of [undefined, null, {}, "", "s", "s".repeat(44), "s".repeat(10_000)]) {
      expect(verifyLocalOwnerProof(key, identity, nonce, proof)).toBe(false)
    }
    expect(() => localOwnerProof(key, identity, "short")).toThrow()
    expect(() => localOwnerProof(key, identity, "s".repeat(10_000))).toThrow()
  })
})
