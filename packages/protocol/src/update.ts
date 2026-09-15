import { z } from "zod"

import { commitShaSchema, sha256DigestSchema } from "./identifiers.js"
import { dateTimeSchema, utf16MaxLength } from "./validation.js"

/** The updater accepts one bounded, operator-visible release channel. */
export const updateChannelSchema = z.enum(["stable", "beta"])
export type UpdateChannel = z.infer<typeof updateChannelSchema>

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
export const updateVersionSchema = z.string().regex(versionPattern, "Update version must be canonical semver")
  .check(utf16MaxLength(128))

export const updateTargetNameSchema = z.string().regex(/^getdomovoi-daemon-[^/]+\.tgz$/)
  .check(utf16MaxLength(256))

export const updateTargetCustomSchema = z.object({
  schemaVersion: z.literal(1),
  version: updateVersionSchema,
  channel: updateChannelSchema,
  sourceCommit: commitShaSchema,
  runtimeLockDigest: sha256DigestSchema,
  minimumUpdaterVersion: updateVersionSchema.optional(),
}).strict()

export const updateTargetSchema = z.object({
  length: z.number().int().positive().safe(),
  hashes: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  custom: updateTargetCustomSchema,
}).strict()

export const updateRoleNameSchema = z.enum(["root", "targets", "snapshot", "timestamp"])
export type UpdateRoleName = z.infer<typeof updateRoleNameSchema>
const tufSpecVersionSchema = z.string().regex(/^1\.0\.\d+$/).check(utf16MaxLength(32))

const keyValueSchema = z.object({ public: z.string().trim().min(1).check(utf16MaxLength(4096)) }).strict()
const signingKeySchema = z.object({
  keytype: z.enum(["ed25519"]),
  scheme: z.literal("ed25519"),
  keyval: keyValueSchema,
}).strict()

const updateRootSignedSchema = z.object({
  _type: z.literal("root"),
  spec_version: tufSpecVersionSchema,
  consistent_snapshot: z.boolean(),
  version: z.number().int().positive().safe(),
  expires: dateTimeSchema,
  keys: z.record(z.string().regex(/^[a-f0-9]{64}$/), signingKeySchema),
  roles: z.record(updateRoleNameSchema, z.object({
    keyids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(16),
    threshold: z.number().int().positive().max(16),
  }).strict()),
}).strict().superRefine((root, context) => {
  for (const role of updateRoleNameSchema.options) {
    const delegation = root.roles[role]
    if (!delegation) {
      context.addIssue({ code: "custom", path: ["roles", role], message: "Every updater role must be delegated" })
      continue
    }
    if (delegation.threshold > delegation.keyids.length) {
      context.addIssue({ code: "custom", path: ["roles", role, "threshold"], message: "Role threshold exceeds its key count" })
    }
    for (const keyid of delegation.keyids) {
      if (!root.keys[keyid]) context.addIssue({ code: "custom", path: ["roles", role, "keyids"], message: "Role references an unknown key" })
    }
  }
})

const signedEnvelopeSchema = z.object({
  signatures: z.array(z.object({
    keyid: z.string().regex(/^[a-f0-9]{64}$/),
    sig: z.string().trim().min(1).check(utf16MaxLength(4096)),
  }).strict()).min(1).max(16),
}).strict()

export const updateRootMetadataSchema = signedEnvelopeSchema.extend({
  signed: updateRootSignedSchema,
}).strict()

export const updateTargetsMetadataSchema = signedEnvelopeSchema.extend({
  signed: z.object({
    _type: z.literal("targets"),
    spec_version: tufSpecVersionSchema,
    version: z.number().int().positive().safe(),
    expires: dateTimeSchema,
    targets: z.record(updateTargetNameSchema, updateTargetSchema),
  }).strict(),
}).strict()

export const updateSnapshotMetadataSchema = signedEnvelopeSchema.extend({
  signed: z.object({
    _type: z.literal("snapshot"),
    spec_version: tufSpecVersionSchema,
    version: z.number().int().positive().safe(),
    expires: dateTimeSchema,
    meta: z.record(z.string().min(1).check(utf16MaxLength(256)), z.object({ version: z.number().int().positive().safe(), length: z.number().int().positive().safe(), hashes: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict()),
  }).strict(),
}).strict()

export const updateTimestampMetadataSchema = signedEnvelopeSchema.extend({
  signed: z.object({
    _type: z.literal("timestamp"),
    spec_version: tufSpecVersionSchema,
    version: z.number().int().positive().safe(),
    expires: dateTimeSchema,
    meta: z.object({
      "snapshot.json": z.object({ version: z.number().int().positive().safe(), length: z.number().int().positive().safe(), hashes: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict(),
    }).strict(),
  }).strict(),
}).strict()

export const updateRefusalReasonSchema = z.enum([
  "network", "malformed-metadata", "signature", "expired", "replay", "target-mismatch",
  "quarantined", "busy", "policy", "activation-failed",
])

const updateRefusalSchema = z.object({
  reason: updateRefusalReasonSchema,
  message: z.string().trim().min(1).check(utf16MaxLength(512)),
}).strict()

export const updateStatusSchema = z.object({
  channel: updateChannelSchema,
  currentVersion: updateVersionSchema,
  currentSourceCommit: commitShaSchema.optional(),
  lastCheckAt: dateTimeSchema.optional(),
  state: z.enum(["idle", "checking", "pending", "deferred", "activating", "quarantined", "failed"]),
  pendingVersion: updateVersionSchema.optional(),
  pendingSourceCommit: commitShaSchema.optional(),
  refusal: updateRefusalSchema.optional(),
}).strict().superRefine((status, context) => {
  if (status.state === "pending" || status.state === "deferred" || status.state === "activating" || status.state === "quarantined") {
    if (!status.pendingVersion || !status.pendingSourceCommit) context.addIssue({ code: "custom", path: ["pendingVersion"], message: "Pending state requires a pending target" })
  } else if (status.pendingVersion !== undefined || status.pendingSourceCommit !== undefined) {
    context.addIssue({ code: "custom", path: ["pendingVersion"], message: "Only pending states may expose a pending target" })
  }
  if (status.state === "failed" || status.state === "quarantined" || status.state === "deferred") {
    if (!status.refusal) context.addIssue({ code: "custom", path: ["refusal"], message: "Failure states require a bounded refusal" })
  } else if (status.refusal !== undefined) {
    context.addIssue({ code: "custom", path: ["refusal"], message: "Refusal is only valid for failure states" })
  }
})

export const updateStatusParamsSchema = z.object({}).strict()
export const updateStatusResultSchema = updateStatusSchema

export const updateCheckParamsSchema = z.object({ channel: updateChannelSchema.optional() }).strict()
export const updateCheckResultSchema = updateStatusSchema

export const updateActivateParamsSchema = z.object({
  version: updateVersionSchema.optional(),
}).strict()
export const updateActivateResultSchema = updateStatusSchema

export type UpdateStatus = z.infer<typeof updateStatusSchema>
export type UpdateRootMetadata = z.infer<typeof updateRootMetadataSchema>
export type UpdateTargetsMetadata = z.infer<typeof updateTargetsMetadataSchema>
export type UpdateSnapshotMetadata = z.infer<typeof updateSnapshotMetadataSchema>
export type UpdateTimestampMetadata = z.infer<typeof updateTimestampMetadataSchema>
export type UpdateCheckParams = z.infer<typeof updateCheckParamsSchema>
export type UpdateActivateParams = z.infer<typeof updateActivateParamsSchema>
