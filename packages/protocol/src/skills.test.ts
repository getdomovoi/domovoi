import { describe, expect, it } from "vitest"

import {
  skillCapabilityManifestSchema,
  skillSignatureSchema,
  skillSummarySchema,
  skillTrustSchema,
} from "./skills.js"

describe("skill security metadata", () => {
  it("accepts the bounded capability vocabulary", () => {
    expect(skillCapabilityManifestSchema.parse({
      version: 1,
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "process.execute",
        "network.connect",
        "secrets.read",
        "preview.render",
      ],
    })).toEqual({
      version: 1,
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "process.execute",
        "network.connect",
        "secrets.read",
        "preview.render",
      ],
    })
  })

  it("rejects unknown and duplicate capability declarations", () => {
    expect(skillCapabilityManifestSchema.safeParse({
      version: 1,
      capabilities: ["machine.takeover"],
    }).success).toBe(false)
    expect(skillCapabilityManifestSchema.safeParse({
      version: 1,
      capabilities: ["filesystem.read", "filesystem.read"],
    }).success).toBe(false)
  })

  it("keeps signature evidence distinct from trust decisions", () => {
    expect(skillSignatureSchema.parse({ state: "unsigned" })).toEqual({ state: "unsigned" })
    expect(skillSignatureSchema.safeParse({
      state: "verified",
      algorithm: "ed25519",
      keyId: "publisher:test-key",
      value: "ZGVjbGFyZWQtc2lnbmF0dXJl",
    }).success).toBe(false)
    expect(skillTrustSchema.safeParse({ state: "trusted", reason: "unsigned" }).success).toBe(false)
    expect(skillSignatureSchema.parse({
      state: "verified",
      algorithm: "ed25519",
      keyId: "publisher:test-key",
      value: "ZGVjbGFyZWQtc2lnbmF0dXJl",
      verifiedBy: "domovoi://trust-store/local",
      verifiedAt: "2026-08-30T09:00:00Z",
    }).state).toBe("verified")
    expect(skillTrustSchema.parse({
      state: "trusted",
      reason: "verified-signature",
      authority: "publisher:test-key",
    }).state).toBe("trusted")
  })

  it("requires every summary to carry digest, signature, trust, and manifest state", () => {
    expect(skillSummarySchema.safeParse({
      id: "skill-111111111111",
      name: "plain",
      description: "Plain instructions.",
      path: "/skills/plain/SKILL.md",
      scope: "user",
      source: "domovoi",
    }).success).toBe(false)
  })
})
