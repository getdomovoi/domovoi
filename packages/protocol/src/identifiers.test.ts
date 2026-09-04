import { describe, expect, it } from "vitest"

import {
  deviceCredentialSchema,
  deviceMachineCredentialParamsSchema,
  deviceSaveCredentialParamsSchema,
  machineCredentialSchema,
} from "./devices.js"
import { machineIdSchema as fleetMachineIdSchema } from "./fleet.js"
import {
  annotationStatusSchema,
  clientIdentityIdSchema,
  clientKindSchema,
  commitShaSchema,
  credentialSchema,
  forkRequestIdSchema,
  machineIdSchema,
  sha256DigestSchema,
  toolKindSchema,
  toolStatusSchema,
  transferIdSchema,
} from "./identifiers.js"
import {
  annotationSetStatusParamsSchema,
  artifactAuthorizeResultSchema,
  sessionForkParamsSchema,
  sessionHistoryEntrySchema,
  workspaceEvidenceSchema,
} from "./rpc.js"
import {
  annotationSchema,
  clientIdentityIdSchema as schemaClientIdentityIdSchema,
  clientKindSchema as schemaClientKindSchema,
  sessionForkOriginSchema,
  sessionSummarySchema,
  threadItemSchema,
} from "./schema.js"
import { skillEnablementReviewSchema } from "./skills.js"
import { transferReceiptSchema } from "./transfer.js"
import {
  transferBeginParamsSchema,
  transferBeginResultSchema,
  transferChunkResultSchema,
  transferHaveResultSchema,
} from "./transfer-rpc.js"
import {
  sessionTransferParamsSchema,
  sessionTransferResultSchema,
  transferFromRefResultSchema,
} from "./transfer-request.js"

function option<T extends { options: readonly unknown[] }>(
  union: T,
  discriminator: string,
  value: string,
) {
  const match = union.options.find((candidate) => {
    const shape = (candidate as { shape: Record<string, unknown> }).shape
    const literal = shape[discriminator] as { value: unknown }
    return literal.value === value
  })
  if (!match) throw new Error(`No ${discriminator} ${value}`)
  return match as { shape: Record<string, unknown> }
}

function unwrap(schema: unknown) {
  return (schema as { unwrap(): unknown }).unwrap()
}

describe("re-exports", () => {
  it("keeps the schemas reachable from where consumers import them", () => {
    expect(schemaClientKindSchema).toBe(clientKindSchema)
    expect(schemaClientIdentityIdSchema).toBe(clientIdentityIdSchema)
    expect(fleetMachineIdSchema).toBe(machineIdSchema)
    expect(deviceCredentialSchema).toBe(credentialSchema)
    expect(machineCredentialSchema).toBe(credentialSchema)
  })
})

describe("client kind", () => {
  it("reviews a skill enablement with the shared client schemas", () => {
    expect(skillEnablementReviewSchema.shape.reviewedBy.shape.client).toBe(clientKindSchema)
    expect(unwrap(skillEnablementReviewSchema.shape.reviewedBy.shape.clientId)).toBe(
      clientIdentityIdSchema,
    )
  })

  it("accepts every client kind and rejects any other in a skill review", () => {
    const review = {
      projectId: "project",
      skillId: `skill-${"a".repeat(12)}`,
      enabled: true,
      contentDigest: `sha256:${"a".repeat(64)}`,
      manifest: { version: 1, capabilities: [] },
      reviewedAt: "2026-09-02T12:00:00.000Z",
    }
    for (const client of clientKindSchema.options) {
      expect(skillEnablementReviewSchema.safeParse({
        ...review,
        reviewedBy: { client },
      }).success).toBe(true)
    }
    expect(clientKindSchema.safeParse("watch").success).toBe(false)
    expect(skillEnablementReviewSchema.safeParse({
      ...review,
      reviewedBy: { client: "watch" },
    }).success).toBe(false)
  })

  it("names the deciding client of a transfer receipt with the shared schemas", () => {
    expect(transferReceiptSchema.shape.decidedBy.shape.client).toBe(clientKindSchema)
    expect(unwrap(transferReceiptSchema.shape.decidedBy.shape.clientId)).toBe(
      clientIdentityIdSchema,
    )
  })
})

describe("machine id", () => {
  it("names every machine id field with machineIdSchema", () => {
    expect(deviceSaveCredentialParamsSchema.shape.machineId).toBe(machineIdSchema)
    expect(deviceMachineCredentialParamsSchema.shape.machineId).toBe(machineIdSchema)
    expect(transferReceiptSchema.shape.sourceMachineId).toBe(machineIdSchema)
    expect(transferReceiptSchema.shape.targetMachineId).toBe(machineIdSchema)
    expect(transferBeginParamsSchema.shape.sourceMachineId).toBe(machineIdSchema)
    expect(sessionTransferParamsSchema.shape.targetMachineId).toBe(machineIdSchema)
  })

  it("accepts a machine id and rejects anything else", () => {
    expect(machineIdSchema.safeParse(`machine-${"a".repeat(32)}`).success).toBe(true)
    expect(machineIdSchema.safeParse(`machine-${"A".repeat(32)}`).success).toBe(false)
    expect(machineIdSchema.safeParse("laptop").success).toBe(false)
  })
})

describe("transfer identifiers", () => {
  it("accepts canonical transfer ids and SHA-256 digests only", () => {
    expect(transferIdSchema.safeParse(`transfer-${"a".repeat(32)}`).success).toBe(true)
    expect(transferIdSchema.safeParse(`transfer-${"A".repeat(32)}`).success).toBe(false)
    expect(transferIdSchema.safeParse(`transfer-${"a".repeat(31)}`).success).toBe(false)
    expect(sha256DigestSchema.safeParse(`sha256:${"b".repeat(64)}`).success).toBe(true)
    expect(sha256DigestSchema.safeParse(`sha256:${"B".repeat(64)}`).success).toBe(false)
    expect(sha256DigestSchema.safeParse(`sha512:${"b".repeat(64)}`).success).toBe(false)
  })
})

describe("credential", () => {
  it("describes device, machine, and signature bytes with credentialSchema", () => {
    expect(artifactAuthorizeResultSchema.shape.signature).toBe(credentialSchema)
  })

  it("accepts 43 base64url characters and rejects anything else", () => {
    expect(credentialSchema.safeParse("n".repeat(43)).success).toBe(true)
    expect(credentialSchema.safeParse("n".repeat(42)).success).toBe(false)
    expect(credentialSchema.safeParse(`${"n".repeat(42)}=`).success).toBe(false)
  })
})

describe("commit sha", () => {
  it("names every commit field with commitShaSchema", () => {
    expect(sessionForkOriginSchema.shape.checkpointCommit).toBe(commitShaSchema)
    expect(unwrap(sessionSummarySchema.shape.archiveCheckpoint)).toBe(commitShaSchema)
    expect(unwrap(option(threadItemSchema, "kind", "checkpoint").shape.commit)).toBe(commitShaSchema)
    expect(transferReceiptSchema.shape.checkpointCommit).toBe(commitShaSchema)
    expect(unwrap(transferBeginParamsSchema.shape.sinceCommit)).toBe(commitShaSchema)
    expect(unwrap(transferBeginResultSchema.shape.haveCommit)).toBe(commitShaSchema)
    expect(unwrap(transferHaveResultSchema.shape.commit)).toBe(commitShaSchema)
    expect(option(transferChunkResultSchema, "state", "restored").shape.checkpointCommit).toBe(commitShaSchema)
    expect(workspaceEvidenceSchema.shape.baseCommit).toBe(commitShaSchema)
    expect(transferFromRefResultSchema.shape.checkpointCommit).toBe(commitShaSchema)
    expect(option(sessionTransferResultSchema, "outcome", "succeeded").shape.checkpointCommit).toBe(commitShaSchema)
    expect(unwrap(option(sessionHistoryEntrySchema, "category", "checkpoints").shape.commit)).toBe(commitShaSchema)
  })

  it("accepts a 40 character lowercase sha and rejects anything else", () => {
    expect(commitShaSchema.safeParse("a".repeat(40)).success).toBe(true)
    expect(commitShaSchema.safeParse("A".repeat(40)).success).toBe(false)
    expect(commitShaSchema.safeParse("a".repeat(39)).success).toBe(false)
  })
})

describe("annotation status", () => {
  it("names every status field with annotationStatusSchema", () => {
    expect(annotationSchema.shape.status).toBe(annotationStatusSchema)
    expect(annotationSetStatusParamsSchema.shape.status).toBe(annotationStatusSchema)
    expect(unwrap(option(sessionHistoryEntrySchema, "category", "annotations").shape.status)).toBe(
      annotationStatusSchema,
    )
  })
})

describe("tool kind and status", () => {
  it("describes a thread tool item and a history tool entry with the shared enums", () => {
    const item = option(threadItemSchema, "kind", "tool").shape
    const entry = option(sessionHistoryEntrySchema, "category", "tools").shape
    expect(item.tool).toBe(toolKindSchema)
    expect(entry.tool).toBe(toolKindSchema)
    expect(item.status).toBe(toolStatusSchema)
    expect(entry.status).toBe(toolStatusSchema)
  })
})

describe("fork request id", () => {
  it("names the fork request id with forkRequestIdSchema", () => {
    expect(sessionForkParamsSchema.shape.requestId).toBe(forkRequestIdSchema)
    expect(sessionForkOriginSchema.shape.requestId).toBe(forkRequestIdSchema)
  })
})
