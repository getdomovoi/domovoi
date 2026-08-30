import { z } from "zod"

export const skillScopeSchema = z.enum(["user", "project", "system"])
export const skillSourceSchema = z.enum(["domovoi", "agents", "kilo", "claude", "codex"])
export const skillIdSchema = z.string().regex(/^skill-[a-f0-9]{12}$/)

export const skillCapabilitySchema = z.enum([
  "filesystem.read",
  "filesystem.write",
  "process.execute",
  "network.connect",
  "secrets.read",
  "preview.render",
])

export const skillCapabilityManifestSchema = z.object({
  version: z.literal(1),
  capabilities: z.array(skillCapabilitySchema).max(32).refine(
    (capabilities) => new Set(capabilities).size === capabilities.length,
    "Capabilities must be unique",
  ),
}).strict()

export const skillFrontmatterConfigSchema = z.object({
  manifest: skillCapabilityManifestSchema.optional(),
}).strict()

const signatureEvidenceSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  value: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(16).max(1_024),
})

export const skillContentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const skillDeclaredSignatureSchema = signatureEvidenceSchema.extend({
  version: z.literal(1),
  contentDigest: skillContentDigestSchema,
}).strict()

export const skillSignatureSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unsigned") }).strict(),
  signatureEvidenceSchema.extend({ state: z.literal("unverified") }).strict(),
  signatureEvidenceSchema.extend({
    state: z.literal("verified"),
    verifiedBy: z.string().trim().min(1).max(256),
    verifiedAt: z.string().datetime({ offset: true }),
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
    authority: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    state: z.literal("blocked"),
    reason: z.enum(["invalid-signature", "revoked-signer"]),
  }).strict(),
])

export const skillSummarySchema = z.object({
  id: skillIdSchema,
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().trim().min(1).max(2_048),
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
  content: z.string().max(128 * 1_024),
})

export type SkillScope = z.infer<typeof skillScopeSchema>
export type SkillSource = z.infer<typeof skillSourceSchema>
export type SkillCapability = z.infer<typeof skillCapabilitySchema>
export type SkillCapabilityManifest = z.infer<typeof skillCapabilityManifestSchema>
export type SkillSignature = z.infer<typeof skillSignatureSchema>
export type SkillTrust = z.infer<typeof skillTrustSchema>
export type SkillSummary = z.infer<typeof skillSummarySchema>
export type SkillDocument = z.infer<typeof skillDocumentSchema>
