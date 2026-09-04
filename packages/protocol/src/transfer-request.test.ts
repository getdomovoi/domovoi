import { describe, expect, it } from "vitest"

import { sourceRefusalSchema } from "./transfer.js"
import { transferRefusalSchema } from "./transfer-preflight.js"
import { transferStreamRefusalSchema } from "./transfer-stream.js"
import {
  sessionTransferContractRefusalSchema,
  sessionTransferPreviewSchema,
} from "./transfer-contract.js"
import {
  sessionTransferParamsSchema,
  sessionTransferPreviewParamsSchema,
  sessionTransferRecoverSourceParamsSchema,
  sessionTransferRefusalMessage,
  sessionTransferResolveConflictParamsSchema,
  sessionTransferResultSchema,
} from "./transfer-request.js"

describe("session transfer request", () => {
  it("names the initiating client without presenting it as transport identity", () => {
    const request = {
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      initiatedByClient: "desktop" as const,
      method: "git-bundle" as const,
    }
    expect(sessionTransferPreviewParamsSchema.parse(request)).toEqual(request)
    expect(sessionTransferPreviewParamsSchema.safeParse({
      ...request,
      initiatedByClient: undefined,
      client: "desktop",
    }).success).toBe(false)
  })

  it("requires the preview contract that freezes a single source owner", () => {
    const request = {
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      initiatedByClient: "desktop",
    }
    expect(sessionTransferParamsSchema.safeParse(request).success).toBe(false)
    expect(sessionTransferParamsSchema.safeParse({
      ...request,
      contractVersion: 1,
      intentDigest: `sha256:${"c".repeat(64)}`,
    }).success).toBe(true)
  })

  it("previews the same transfer before requiring its intent digest", () => {
    const request = {
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      method: "git-bundle" as const,
      initiatedByClient: "desktop" as const,
    }
    expect(sessionTransferPreviewParamsSchema.parse(request)).toEqual(request)
    expect(sessionTransferParamsSchema.safeParse({
      ...request,
      contractVersion: 1,
      intentDigest: `sha256:${"c".repeat(64)}`,
    }).success).toBe(true)
    expect(sessionTransferParamsSchema.safeParse({
      ...request,
      contractVersion: 1,
    }).success).toBe(false)
  })

  it("refuses a target that is not a machine", () => {
    expect(sessionTransferParamsSchema.safeParse({
      sessionId: "session-1",
      targetMachineId: "studio",
      initiatedByClient: "desktop",
    }).success).toBe(false)
  })

  it("accepts a named remote only for the remote-ref path", () => {
    const request = {
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      initiatedByClient: "desktop" as const,
      contractVersion: 1 as const,
      intentDigest: `sha256:${"c".repeat(64)}`,
    }
    expect(sessionTransferParamsSchema.safeParse({
      ...request,
      method: "remote-ref",
      remote: "origin",
    }).success).toBe(true)
    expect(sessionTransferParamsSchema.safeParse({
      ...request,
      method: "remote-ref",
    }).success).toBe(false)
    expect(sessionTransferParamsSchema.safeParse({
      ...request,
      method: "git-bundle",
      remote: "origin",
    }).success).toBe(false)
  })

  it("reports where a moved session now lives", () => {
    expect(sessionTransferResultSchema.safeParse({
      outcome: "succeeded",
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "c".repeat(40),
    }).success).toBe(false)
    expect(sessionTransferResultSchema.safeParse({
      outcome: "succeeded",
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "c".repeat(40),
      contractVersion: 1,
      transferId: `transfer-${"d".repeat(32)}`,
      ownershipGeneration: 2,
      coverage: { included: [], excluded: [], warnings: [] },
    }).success).toBe(true)
  })

  it("reports a refusal with the reason it was refused", () => {
    expect(sessionTransferResultSchema.safeParse({
      outcome: "refused",
      reason: "target-unreachable",
    }).success).toBe(true)
  })

  it("rejects the legacy unclassified transfer failure", () => {
    expect(sessionTransferResultSchema.safeParse({ outcome: "failed" }).success).toBe(false)
    expect(sessionTransferResultSchema.safeParse({
      outcome: "failed",
      reason: "target-unreachable",
    }).success).toBe(false)
  })

  it("reports an incomplete target recovery without claiming success", () => {
    const transferId = `transfer-${"d".repeat(32)}`
    for (const incomplete of [
      { state: "unknown", recoveryAction: "none" },
      { state: "receiving", recoveryAction: "none" },
      { state: "prepared", recoveryAction: "none" },
      { state: "recovering", stage: "persistence", recoveryAction: "none" },
      { state: "failed", reason: "persistence-failed", recoveryAction: "none" },
      { state: "ownership-unconfirmed", recoveryAction: "confirm-source-recovery" },
      { state: "ownership-conflict", recoveryAction: "keep-target-session" },
    ] as const) {
      expect(sessionTransferResultSchema.safeParse({
        outcome: "incomplete",
        transferId,
        ...incomplete,
      }).success).toBe(true)
    }
    expect(sessionTransferResultSchema.safeParse({
      outcome: "incomplete",
      transferId,
      state: "unknown",
      recoveryAction: "check-status",
    }).success).toBe(false)
  })

  it("requires an explicit literal before reclaiming an unverifiable source", () => {
    const params = {
      sessionId: "session-1",
      transferId: `transfer-${"d".repeat(32)}`,
      confirmation: "target-does-not-have-session" as const,
      initiatedByClient: "desktop" as const,
    }
    expect(sessionTransferRecoverSourceParamsSchema.parse(params)).toEqual(params)
    expect(sessionTransferRecoverSourceParamsSchema.safeParse({
      ...params,
      confirmation: "retry",
    }).success).toBe(false)
  })

  it("requires an explicit literal before releasing a conflicted source", () => {
    const params = {
      sessionId: "session-1",
      transferId: `transfer-${"d".repeat(32)}`,
      confirmation: "keep-target-session" as const,
      initiatedByClient: "desktop" as const,
    }
    expect(sessionTransferResolveConflictParamsSchema.parse(params)).toEqual(params)
    expect(sessionTransferResolveConflictParamsSchema.safeParse({
      ...params,
      confirmation: "keep-source-session",
    }).success).toBe(false)
  })
})

describe("session transfer refusal messages", () => {
  it("names why the target machine refused the move", () => {
    expect(sessionTransferRefusalMessage("target-upgrade-required"))
      .toBe("That machine runs an older Domovoi and needs an upgrade first")
  })

  it("names why the source session could not be moved", () => {
    expect(sessionTransferRefusalMessage("session-turn-active"))
      .toBe("This session is mid turn, so it cannot move until the turn settles")
    expect(sessionTransferRefusalMessage("source-bundle-create-unavailable"))
      .toContain("cannot create the Git bundle")
    expect(sessionTransferRefusalMessage("source-ref-push-unavailable"))
      .toContain("cannot publish the Git ref")
  })

  it("names why the arriving bytes were rejected", () => {
    expect(sessionTransferRefusalMessage("digest-mismatch"))
      .toBe("The transferred repository bytes did not match their digest, so the move was rejected")
  })

  it("covers every refusal the daemon can answer with", () => {
    const reasons = [
      ...transferRefusalSchema.options,
      ...sourceRefusalSchema.options,
      ...transferStreamRefusalSchema.options,
      // Listed by hand, this missed session-resource-unavailable when the
      // contract gained it. The schema is the authority on what can be
      // refused, so a new key is covered the moment it is added.
      ...sessionTransferContractRefusalSchema.options,
    ]
    for (const reason of reasons) {
      expect(sessionTransferRefusalMessage(reason).length).toBeGreaterThan(0)
    }
  })

  it("keeps preview refusal keys disjoint and accepts every source of refusal", () => {
    const reasonSets = [
      sessionTransferContractRefusalSchema.options,
      sourceRefusalSchema.options,
      transferRefusalSchema.options,
    ]
    const reasons = reasonSets.flat()
    expect(new Set(reasons).size).toBe(reasons.length)
    for (const reason of reasons) {
      expect(sessionTransferPreviewSchema.safeParse({
        allowed: false,
        contractVersion: 1,
        sessionId: "session-1",
        sourceMachineId: `machine-${"a".repeat(32)}`,
        targetMachineId: `machine-${"b".repeat(32)}`,
        coverage: { included: [], excluded: [], warnings: [] },
        reason,
      }).success).toBe(true)
    }
  })
})
