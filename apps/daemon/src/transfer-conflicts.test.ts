import { describe, expect, it } from "vitest"

import { sessionTransferContractVersion } from "@getdomovoi/protocol"

import { detectedTransferConflictSchema } from "./transfer-conflicts.js"

const transferId = `transfer-${"a".repeat(32)}`
const sourceMachineId = `machine-${"b".repeat(32)}`
const targetMachineId = `machine-${"c".repeat(32)}`
const manifestDigest = `sha256:${"d".repeat(64)}`
const detectedAt = "2026-09-04T01:00:00.000Z"

const sourceRecovery = {
  transferId,
  targetMachineId,
  generation: 1,
  manifestDigest,
  recoveredAt: "2026-09-04T00:00:00.000Z",
  decidedBy: { client: "desktop" as const, clientId: "studio-mac" },
}

const common = {
  version: sessionTransferContractVersion,
  sessionId: "session-1",
  sourceMachineId,
  sourceProjectId: "project-source",
  workspacePath: "/source/session",
}

describe("durable transfer conflict proofs", () => {
  it("migrates a legacy flat recovery proof without weakening its evidence", () => {
    expect(detectedTransferConflictSchema.parse({
      ...common,
      sourceRecovery,
      transferId,
      otherMachineId: targetMachineId,
      otherGeneration: 2,
      detectedAt,
      recoveryAction: "none",
    })).toEqual({
      ...common,
      ownershipGeneration: 1,
      sourceRecovery,
      conflict: {
        kind: "recovery-contradicted",
        transferId,
        otherMachineId: targetMachineId,
        otherGeneration: 2,
        detectedAt,
        recoveryAction: "keep-target-session",
      },
    })
  })

  it("stores direct target evidence without inventing a recovery claim", () => {
    expect(detectedTransferConflictSchema.parse({
      ...common,
      ownershipGeneration: 1,
      conflict: {
        kind: "target-session-detected",
        reason: "target-session-newer",
        transferId,
        otherMachineId: targetMachineId,
        otherGeneration: 2,
        manifestDigest,
        detectedAt,
        recoveryAction: "keep-target-session",
      },
    })).not.toHaveProperty("sourceRecovery")
  })

  it("rejects direct evidence that contradicts its ownership relation", () => {
    expect(detectedTransferConflictSchema.safeParse({
      ...common,
      ownershipGeneration: 2,
      conflict: {
        kind: "target-session-detected",
        reason: "target-session-newer",
        transferId,
        otherMachineId: targetMachineId,
        otherGeneration: 1,
        manifestDigest,
        detectedAt,
        recoveryAction: "keep-target-session",
      },
    }).success).toBe(false)
  })
})
