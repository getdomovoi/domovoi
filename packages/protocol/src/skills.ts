import { z } from "zod"

import { offsetDateTimeSchema, utf16MaxLength } from "./validation.js"

import { clientIdentityIdSchema, clientKindSchema } from "./identifiers.js"
import { skillCapabilityManifestSchema, skillCapabilitySchema } from "./skill-scopes.js"
export * from "./skill-scopes.js"

export const skillScopeSchema = z.enum(["user", "project", "system"])
export const skillSourceSchema = z.enum(["domovoi", "agents", "kilo", "claude", "codex"])
export const skillIdSchema = z.string().regex(/^skill-[a-f0-9]{12}$/)
export const maximumTurnSkillSelections = 8

export const skillFrontmatterConfigSchema = z.object({
  manifest: skillCapabilityManifestSchema.optional(),
}).strict()

const signatureEvidenceSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  value: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(16).check(utf16MaxLength(1_024)),
})

export const skillContentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const maximumSkillRevisionBytes = 128 * 1_024
// This synchronous wire schema checks shape and exact UTF-8 size. The daemon
// verifies contentDigest when retaining a revision and again before serving it.
export const skillReviewRevisionResultSchema = z.discriminatedUnion("state", [
  z.object({
    id: skillIdSchema,
    contentDigest: skillContentDigestSchema,
    state: z.literal("available"),
    content: z.string().check(utf16MaxLength(maximumSkillRevisionBytes)),
    bytes: z.number().int().nonnegative().max(maximumSkillRevisionBytes),
  }).strict().refine((value) => new TextEncoder().encode(value.content).byteLength === value.bytes, "Revision byte count must match its exact UTF-8 text"),
  z.object({
    id: skillIdSchema,
    contentDigest: skillContentDigestSchema,
    state: z.literal("unavailable"),
    reason: z.enum(["not-retained", "integrity-mismatch"]),
  }).strict(),
])
export type SkillReviewRevisionResult = z.infer<typeof skillReviewRevisionResultSchema>

export const skillDeclaredSignatureSchema = signatureEvidenceSchema.extend({
  version: z.literal(1),
  contentDigest: skillContentDigestSchema,
}).strict()

export const skillSignatureSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unsigned") }).strict(),
  signatureEvidenceSchema.extend({ state: z.literal("unverified") }).strict(),
  signatureEvidenceSchema.extend({
    state: z.literal("verified"),
    verifiedBy: z.string().trim().min(1).check(utf16MaxLength(256)),
    verifiedAt: offsetDateTimeSchema,
  }).strict(),
  z.object({
    state: z.literal("invalid"),
    reason: z.enum(["malformed", "verification-failed", "revoked-signer"]),
  }).strict(),
])

export const skillTrustSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("untrusted"),
    reason: z.enum(["unsigned", "unverified-signature"]),
  }).strict(),
  z.object({
    state: z.literal("trusted"),
    reason: z.enum(["verified-signature", "manual-review"]),
    authority: z.string().trim().min(1).check(utf16MaxLength(256)),
  }).strict(),
  z.object({
    state: z.literal("blocked"),
    reason: z.enum(["invalid-signature", "revoked-signer"]),
  }).strict(),
])

export const skillSummarySchema = z.object({
  id: skillIdSchema,
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).check(utf16MaxLength(64)),
  description: z.string().trim().min(1).check(utf16MaxLength(2_048)),
  path: z.string().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/),
  scope: skillScopeSchema,
  source: skillSourceSchema,
  manifest: skillCapabilityManifestSchema,
  contentDigest: skillContentDigestSchema,
  signature: skillSignatureSchema,
  trust: skillTrustSchema,
})

export const skillSummariesSchema = z.array(skillSummarySchema).max(512)
export const skillDocumentSchema = z.object({
  skill: skillSummarySchema,
  content: z.string().check(utf16MaxLength(128 * 1_024)),
})

export const skillInventorySignatureSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unsigned") }).strict(),
  z.object({ state: z.literal("unverified") }).strict(),
  z.object({ state: z.literal("verified") }).strict(),
  z.object({
    state: z.literal("invalid"),
    reason: z.enum(["malformed", "verification-failed", "revoked-signer"]),
  }).strict(),
])

export const skillInventoryTrustSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("untrusted"),
    reason: z.enum(["unsigned", "unverified-signature"]),
  }).strict(),
  z.object({
    state: z.literal("trusted"),
    reason: z.enum(["verified-signature", "manual-review"]),
  }).strict(),
  z.object({
    state: z.literal("blocked"),
    reason: z.enum(["invalid-signature", "revoked-signer"]),
  }).strict(),
])

export const skillInventoryEntrySchema = z.object({
  id: skillIdSchema,
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).check(utf16MaxLength(64)),
  scope: skillScopeSchema,
  source: skillSourceSchema,
  manifest: skillCapabilityManifestSchema,
  contentDigest: skillContentDigestSchema,
  signature: skillInventorySignatureSchema,
  trust: skillInventoryTrustSchema,
}).strict()

export const skillInventoryMachineSchema = z.object({
  id: z.string().trim().min(1).check(utf16MaxLength(128)),
  name: z.string().trim().min(1).check(utf16MaxLength(256)),
  platform: z.string().trim().min(1).check(utf16MaxLength(64)),
  arch: z.string().trim().min(1).check(utf16MaxLength(64)),
  version: z.string().trim().min(1).check(utf16MaxLength(64)),
}).strict()

export const skillInventorySchema = z.object({
  machine: skillInventoryMachineSchema,
  skills: z.array(skillInventoryEntrySchema).max(512),
}).strict()

export const skillInventorySourceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), inventory: skillInventorySchema }).strict(),
  z.object({ state: z.literal("unknown"), machine: skillInventoryMachineSchema }).strict(),
  z.object({ state: z.literal("unreachable"), machine: skillInventoryMachineSchema }).strict(),
])

export function skillInventoryEntryFromSummary(skill: SkillSummary): SkillInventoryEntry {
  const signature = skill.signature.state === "invalid"
    ? { state: skill.signature.state, reason: skill.signature.reason }
    : { state: skill.signature.state }
  const trust = { state: skill.trust.state, reason: skill.trust.reason }
  return skillInventoryEntrySchema.parse({
    id: skill.id,
    name: skill.name,
    scope: skill.scope,
    source: skill.source,
    manifest: skill.manifest,
    contentDigest: skill.contentDigest,
    signature,
    trust,
  })
}

export const skillEnablementReviewSchema = z.object({
  projectId: z.string().trim().min(1).check(utf16MaxLength(512)),
  skillId: skillIdSchema,
  enabled: z.boolean(),
  contentDigest: skillContentDigestSchema,
  manifest: skillCapabilityManifestSchema,
  reviewedAt: offsetDateTimeSchema,
  reviewedBy: z.object({
    client: clientKindSchema,
    clientId: clientIdentityIdSchema.optional(),
  }).strict(),
}).strict()

export const skillEnablementReviewsSchema = z.array(skillEnablementReviewSchema).max(2_048)

export const turnSkillSelectionReferenceSchema = z.object({
  skillId: skillIdSchema,
  review: z.object({
    contentDigest: skillContentDigestSchema,
    manifest: skillCapabilityManifestSchema,
  }).strict(),
}).strict()

export const turnSkillSelectionSchema = z.object({
  mode: z.literal("turn-explicit"),
  skills: z.array(turnSkillSelectionReferenceSchema)
    .max(maximumTurnSkillSelections)
    .superRefine((skills, context) => {
      const ids = skills.map((skill) => skill.skillId)
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          message: "Turn skill selections must be unique",
        })
      }
    }),
}).strict()

export const turnSkillSelectionRefusalSchema = z.object({
  kind: z.literal("turn-skill-selection-refused"),
  skillId: skillIdSchema,
  reason: z.enum(["not-enabled", "unavailable", "review-changed", "policy"]),
}).strict()

export const skillReviewDecisionSchema = z.enum(["trust", "revoke"])

export const maximumSkillInstallFiles = 256
export const skillInstallScopeSchema = z.enum(["project", "user"])
const skillInstallPathSchema = z.string().min(1).check(utf16MaxLength(1_024)).regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
const skillInstallRelativePathSchema = z.string().min(1).check(utf16MaxLength(1_024))

export const skillInstallSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: skillInstallPathSchema }).strict(),
])

export const skillInstallRefusalSchema = z.object({
  kind: z.literal("skill-install-refused"),
  reason: z.enum([
    "source-changed",
    "blocked",
    "name-conflict",
    "symlink-escapes-source",
    "source-too-large",
  ]),
  path: skillInstallRelativePathSchema.optional(),
}).strict()

export const skillInstallTargetSchema = z.object({
  scope: skillInstallScopeSchema,
  path: skillInstallPathSchema,
  state: z.enum(["available", "installed", "conflict"]),
}).strict()

export const skillInstallPreviewSchema = z.object({
  source: skillInstallSourceSchema,
  name: skillSummarySchema.shape.name,
  description: skillSummarySchema.shape.description,
  manifest: skillCapabilityManifestSchema,
  contentDigest: skillContentDigestSchema,
  sourceDigest: skillContentDigestSchema,
  signature: skillSignatureSchema,
  trust: skillTrustSchema,
  files: z.array(z.object({
    path: skillInstallRelativePathSchema,
    bytes: z.number().int().nonnegative(),
  }).strict()).max(maximumSkillInstallFiles),
  targets: z.array(skillInstallTargetSchema).max(skillInstallScopeSchema.options.length),
  refusals: z.array(skillInstallRefusalSchema).max(maximumSkillInstallFiles),
}).strict()

export const skillManualReviewSchema = z.object({
  skillId: skillIdSchema,
  contentDigest: skillContentDigestSchema,
  reviewedAt: offsetDateTimeSchema,
  reviewedBy: z.object({
    client: clientKindSchema,
    clientId: clientIdentityIdSchema.optional(),
  }).strict(),
}).strict()

export type SkillScope = z.infer<typeof skillScopeSchema>
export type SkillSource = z.infer<typeof skillSourceSchema>
export type SkillCapability = z.infer<typeof skillCapabilitySchema>
export type SkillCapabilityManifest = z.infer<typeof skillCapabilityManifestSchema>
export type SkillSignature = z.infer<typeof skillSignatureSchema>
export type SkillTrust = z.infer<typeof skillTrustSchema>
export type SkillSummary = z.infer<typeof skillSummarySchema>
export type SkillDocument = z.infer<typeof skillDocumentSchema>
export type SkillEnablementReview = z.infer<typeof skillEnablementReviewSchema>
export type TurnSkillSelectionReference = z.infer<typeof turnSkillSelectionReferenceSchema>
export type TurnSkillSelection = z.infer<typeof turnSkillSelectionSchema>
export type TurnSkillSelectionRefusal = z.infer<typeof turnSkillSelectionRefusalSchema>
export type SkillReviewDecision = z.infer<typeof skillReviewDecisionSchema>
export type SkillInstallScope = z.infer<typeof skillInstallScopeSchema>
export type SkillInstallSource = z.infer<typeof skillInstallSourceSchema>
export type SkillInstallRefusal = z.infer<typeof skillInstallRefusalSchema>
export type SkillInstallTarget = z.infer<typeof skillInstallTargetSchema>
export type SkillInstallPreview = z.infer<typeof skillInstallPreviewSchema>
export type SkillManualReview = z.infer<typeof skillManualReviewSchema>
export type SkillInventorySignature = z.infer<typeof skillInventorySignatureSchema>
export type SkillInventoryTrust = z.infer<typeof skillInventoryTrustSchema>
export type SkillInventoryEntry = z.infer<typeof skillInventoryEntrySchema>
export type SkillInventoryMachine = z.infer<typeof skillInventoryMachineSchema>
export type SkillInventory = z.infer<typeof skillInventorySchema>
export type SkillInventorySource = z.infer<typeof skillInventorySourceSchema>
