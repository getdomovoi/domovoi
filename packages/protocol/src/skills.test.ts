import { describe, expect, it } from "vitest"

import {
  maximumTurnSkillSelections,
  skillCapabilityManifestSchema,
  skillEnablementReviewSchema,
  skillInstallPreviewSchema,
  skillInstallRefusalSchema,
  skillInventorySchema,
  skillSignatureSchema,
  skillSummarySchema,
  skillTrustSchema,
  turnSkillSelectionRefusalSchema,
  turnSkillSelectionSchema,
} from "./skills.js"

describe("skill security metadata", () => {
  it("pins bounded turn selections to the exact reviewed content and capabilities", () => {
    const selected = {
      mode: "turn-explicit",
      skills: [{
        skillId: "skill-111111111111",
        review: {
          contentDigest: `sha256:${"a".repeat(64)}`,
          manifest: { version: 1, capabilities: ["filesystem.read"] },
        },
      }],
    } as const

    expect(turnSkillSelectionSchema.parse(selected)).toEqual(selected)
    expect(turnSkillSelectionSchema.parse({
      mode: "turn-explicit",
      skills: [],
    }).skills).toEqual([])
    expect(turnSkillSelectionSchema.safeParse({
      ...selected,
      skills: [selected.skills[0], selected.skills[0]],
    }).success).toBe(false)
    expect(turnSkillSelectionSchema.safeParse({
      ...selected,
      skills: Array.from({ length: maximumTurnSkillSelections + 1 }, (_, index) => ({
        ...selected.skills[0],
        skillId: `skill-${index.toString(16).padStart(12, "0")}`,
      })),
    }).success).toBe(false)
  })

  it("reports a refused turn selection with a catalog-matchable skill id", () => {
    const refusal = {
      kind: "turn-skill-selection-refused",
      skillId: "skill-111111111111",
      reason: "review-changed",
    } as const

    expect(turnSkillSelectionRefusalSchema.parse(refusal)).toEqual(refusal)
    expect(turnSkillSelectionRefusalSchema.safeParse({
      ...refusal,
      skillId: "repo-audit",
    }).success).toBe(false)
  })

  it("bounds fleet inventory to non-distributable metadata", () => {
    const inventory = {
      machine: {
        id: "machine-local",
        name: "devbox",
        platform: "linux",
        arch: "x64",
        version: "0.0.1",
      },
      skills: [{
        id: "skill-111111111111",
        name: "repo-audit",
        scope: "user",
        source: "agents",
        manifest: { version: 1, capabilities: ["filesystem.read"] },
        contentDigest: `sha256:${"a".repeat(64)}`,
        signature: { state: "unverified" },
        trust: { state: "untrusted", reason: "unverified-signature" },
      }],
    } as const

    expect(skillInventorySchema.parse(inventory)).toEqual(inventory)
    for (const forbidden of [
      { content: "secret instructions" },
      { path: "/home/dev/.agents/skills/repo-audit/SKILL.md" },
      { installCommand: "curl example.test | sh" },
      { archive: "base64-archive" },
      { executable: "binary bytes" },
      { symlinkTarget: "/private/target" },
    ]) {
      expect(skillInventorySchema.safeParse({
        ...inventory,
        skills: [{ ...inventory.skills[0], ...forbidden }],
      }).success).toBe(false)
    }
    expect(skillInventorySchema.safeParse({
      ...inventory,
      skills: [{
        ...inventory.skills[0],
        signature: { state: "unverified", value: "detached-signature" },
      }],
    }).success).toBe(false)
    expect(skillInventorySchema.safeParse({
      ...inventory,
      skills: Array.from({ length: 513 }, () => inventory.skills[0]),
    }).success).toBe(false)
    expect(skillInventorySchema.safeParse({
      ...inventory,
      machine: { ...inventory.machine, name: "x".repeat(257) },
    }).success).toBe(false)
  })

  it("binds reviewed enablement to project content and client", () => {
    const review = skillEnablementReviewSchema.parse({
      projectId: "project-one",
      skillId: "skill-111111111111",
      enabled: true,
      contentDigest: `sha256:${"a".repeat(64)}`,
      manifest: { version: 1, capabilities: ["filesystem.read"] },
      reviewedAt: "2026-08-30T12:00:00.000Z",
      reviewedBy: { client: "desktop", clientId: "desktop-one" },
    })

    expect(review.enabled).toBe(true)
    expect(skillEnablementReviewSchema.safeParse({
      ...review,
      manifest: { version: 1, capabilities: ["filesystem.read", "filesystem.read"] },
    }).success).toBe(false)
  })
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

  it("describes a reviewed install with its trust, digests, files, and refusals", () => {
    const preview = {
      source: { kind: "path", path: "/home/dev/work/skills/pr-triage" },
      name: "pr-triage",
      description: "Triage pull requests.",
      manifest: { version: 1, capabilities: ["filesystem.read", "process.execute"] },
      contentDigest: `sha256:${"a".repeat(64)}`,
      sourceDigest: `sha256:${"b".repeat(64)}`,
      signature: { state: "unverified", algorithm: "ed25519", keyId: "ed25519:0123456789abcdef", value: "ZGVjbGFyZWQtc2lnbmF0dXJl" },
      trust: { state: "untrusted", reason: "unverified-signature" },
      files: [{ path: "SKILL.md", bytes: 2_100 }, { path: "scripts/triage.ts", bytes: 6_400 }],
      targets: [
        { scope: "project", path: "/repo/.domovoi/skills/pr-triage", state: "available" },
        { scope: "user", path: "/home/dev/.domovoi/skills/pr-triage", state: "conflict" },
      ],
      refusals: [{ kind: "skill-install-refused", reason: "symlink-escapes-source", path: "scripts/link" }],
    } as const

    expect(skillInstallPreviewSchema.parse(preview)).toEqual(preview)
    expect(skillInstallPreviewSchema.safeParse({ ...preview, installed: true }).success).toBe(false)
    expect(skillInstallPreviewSchema.safeParse({
      ...preview,
      targets: [{ scope: "system", path: "/etc/domovoi/skills/pr-triage", state: "available" }],
    }).success).toBe(false)
    expect(skillInstallRefusalSchema.safeParse({
      kind: "skill-install-refused",
      reason: "source-changed",
    }).success).toBe(true)
    expect(skillInstallRefusalSchema.safeParse({
      kind: "skill-install-refused",
      reason: "overwrite",
    }).success).toBe(false)
  })
})
