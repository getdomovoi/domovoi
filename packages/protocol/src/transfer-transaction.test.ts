import { describe, expect, it } from "vitest"

import { isMutatingRpcMethod, rpcMethods } from "./rpc.js"
import {
  sessionTransferPreviewParamsSchema,
  sessionTransferRecoverSourceParamsSchema,
  sessionTransferResolveConflictParamsSchema,
} from "./transfer-request.js"
import {
  transferAbortParamsSchema,
  sessionTransferManifestSchema,
  transferCommitParamsSchema,
  transferMemberResultSchema,
  transferMemberChunkBytes,
  transferPrepareResultSchema,
  transferStatusParamsSchema,
  transferAbortResultSchema,
  transferCommitResultSchema,
  transferMemberParamsSchema,
  transferPrepareParamsSchema,
  transferStatusResultSchema,
  transferTargetPreflightParamsSchema,
  transferTargetPreflightResultSchema,
} from "./transfer-transaction.js"

const transferId = `transfer-${"a".repeat(32)}`
const sourceMachineId = `machine-${"b".repeat(32)}`
const targetMachineId = `machine-${"c".repeat(32)}`
const digest = (character: string) => `sha256:${character.repeat(64)}`

const coverage = {
  included: [
    { kind: "repository" as const, count: 1 },
    { kind: "thread" as const, count: 2 },
    { kind: "artifacts" as const, count: 1 },
    { kind: "artifact-sources" as const, count: 1 },
    { kind: "annotations" as const, count: 1 },
    { kind: "annotation-crops" as const, count: 1 },
    { kind: "working-plan" as const, count: 1 },
    { kind: "usage" as const, count: 1 },
    { kind: "runtime-settings" as const, count: 1 },
  ],
  excluded: [{ kind: "provider-credentials" as const }],
  warnings: [{ kind: "promoted-ignored-artifacts" as const, count: 1 }],
}

const members = [
  {
    memberId: "state",
    kind: "session-state" as const,
    digest: digest("1"),
    byteLength: 2_048,
  },
  {
    memberId: "repository",
    kind: "repository-bundle" as const,
    digest: digest("2"),
    byteLength: 8_192,
  },
  {
    memberId: "artifact-source-1",
    kind: "artifact-source" as const,
    artifactId: "artifact-preview",
    digest: digest("3"),
    byteLength: 1_024,
  },
  {
    memberId: "annotation-crop-1",
    kind: "annotation-crop" as const,
    ref: `crop-${"4".repeat(64)}`,
    mimeType: "image/png" as const,
    digest: digest("4"),
    byteLength: 512,
  },
]

const manifest = {
  version: 1 as const,
  transferId,
  sessionId: "session-1",
  sourceMachineId,
  targetMachineId,
  intentDigest: digest("5"),
  createdAt: "2026-09-03T19:00:00.000Z",
  ownership: { fromGeneration: 2, toGeneration: 3 },
  project: {
    sourceProjectId: "project-source",
    targetProjectId: "project-target",
    lineageCommit: "6".repeat(40),
    checkpointCommit: "7".repeat(40),
  },
  repository: { method: "git-bundle" as const, memberId: "repository" },
  stateMemberId: "state",
  members,
  totalBytes: members.reduce((total, member) => total + member.byteLength, 0),
  coverage,
}

describe("session transfer manifest", () => {
  it("binds repository, portable state, and resources into one transfer", () => {
    expect(sessionTransferManifestSchema.parse(manifest)).toEqual(manifest)
    const { targetProjectId: _targetProjectId, ...unboundProject } = manifest.project
    expect(sessionTransferManifestSchema.safeParse({
      ...manifest,
      project: unboundProject,
    }).success).toBe(false)
  })

  it("requires one ownership-generation advance", () => {
    expect(sessionTransferManifestSchema.safeParse({
      ...manifest,
      ownership: { fromGeneration: 2, toGeneration: 4 },
    }).success).toBe(false)
  })

  it("requires declared unique members and their exact total", () => {
    expect(sessionTransferManifestSchema.safeParse({
      ...manifest,
      members: [...members, members[0]],
      totalBytes: manifest.totalBytes + members[0]!.byteLength,
    }).success).toBe(false)
    expect(sessionTransferManifestSchema.safeParse({
      ...manifest,
      totalBytes: manifest.totalBytes + 1,
    }).success).toBe(false)
    expect(sessionTransferManifestSchema.safeParse({
      ...manifest,
      stateMemberId: "repository",
    }).success).toBe(false)
  })

  it("requires the repository member only for bundle transport", () => {
    expect(sessionTransferManifestSchema.safeParse({
      ...manifest,
      repository: { method: "git-bundle", memberId: "state" },
    }).success).toBe(false)
    expect(sessionTransferManifestSchema.safeParse({
      ...manifest,
      repository: {
        method: "remote-ref",
        remote: "origin",
        ref: "refs/domovoi/sessions/session-1",
        commit: "7".repeat(40),
      },
      members: members.filter((member) => member.kind !== "repository-bundle"),
      totalBytes: manifest.totalBytes - members[1]!.byteLength,
    }).success).toBe(true)
  })
})

describe("transactional transfer rpc", () => {
  it("registers preview and recovery queries as reads and transaction writes as mutations", () => {
    expect(rpcMethods["session.transferPreview"].params).toBe(sessionTransferPreviewParamsSchema)
    expect(rpcMethods["session.transferRecoverSource"].params)
      .toBe(sessionTransferRecoverSourceParamsSchema)
    expect(rpcMethods["session.transferResolveConflict"].params)
      .toBe(sessionTransferResolveConflictParamsSchema)
    expect(rpcMethods["transfer.preflight"].params).toBe(transferTargetPreflightParamsSchema)
    expect(rpcMethods["transfer.prepare"].params).toBe(transferPrepareParamsSchema)
    expect(rpcMethods["transfer.member"].params).toBe(transferMemberParamsSchema)
    expect(rpcMethods["transfer.commit"].params).toBe(transferCommitParamsSchema)
    expect(rpcMethods["transfer.status"].params).toBe(transferStatusParamsSchema)
    expect(rpcMethods["transfer.abort"].params).toBe(transferAbortParamsSchema)

    expect(isMutatingRpcMethod("session.transferPreview")).toBe(false)
    expect(isMutatingRpcMethod("session.transferRecoverSource")).toBe(true)
    expect(isMutatingRpcMethod("session.transferResolveConflict")).toBe(true)
    expect(isMutatingRpcMethod("transfer.preflight")).toBe(false)
    expect(isMutatingRpcMethod("transfer.status")).toBe(false)
    for (const method of [
      "transfer.prepare",
      "transfer.member",
      "transfer.commit",
      "transfer.abort",
    ] as const) {
      expect(isMutatingRpcMethod(method)).toBe(true)
    }
  })

  it("checks target lineage and ownership before a preview promises a move", () => {
    const request = {
      sessionId: "session-1",
      sourceMachineId,
      sourceProjectId: "project-source",
      lineageCommit: "6".repeat(40),
      ownershipGeneration: 2,
      contractVersion: 1,
      method: "git-bundle",
      coverage: { included: [], excluded: [], warnings: [] },
      client: "desktop",
    }
    expect(transferTargetPreflightParamsSchema.safeParse(request).success).toBe(true)
    const { contractVersion: _version, ...unversioned } = request
    expect(transferTargetPreflightParamsSchema.safeParse(unversioned).success).toBe(false)
    expect(transferTargetPreflightResultSchema.safeParse({
      allowed: true,
      targetProjectId: "project-target",
      lineageCommit: "6".repeat(40),
    }).success).toBe(true)
    expect(transferTargetPreflightResultSchema.safeParse({
      allowed: false,
      reason: "target-project-mismatch",
    }).success).toBe(true)
    for (const reason of [
      "target-lineage-check-unavailable",
      "target-bundle-restore-unavailable",
      "target-ref-restore-unavailable",
      "target-artifact-import-unavailable",
      "target-usage-import-unavailable",
      "target-state-persistence-unavailable",
    ] as const) {
      expect(transferTargetPreflightResultSchema.safeParse({ allowed: false, reason }).success)
        .toBe(true)
    }
    for (const reason of ["target-session-newer", "target-session-diverged"] as const) {
      expect(transferTargetPreflightResultSchema.safeParse({
        allowed: false,
        reason,
        existingGeneration: 3,
      }).success).toBe(true)
      expect(transferTargetPreflightResultSchema.safeParse({ allowed: false, reason }).success)
        .toBe(false)
      expect(transferPrepareResultSchema.safeParse({
        state: "refused",
        transferId,
        reason,
        existingGeneration: 3,
      }).success).toBe(true)
      expect(transferPrepareResultSchema.safeParse({
        state: "refused",
        transferId,
        reason,
      }).success).toBe(false)
      expect(transferCommitResultSchema.safeParse({
        state: "refused",
        transferId,
        reason,
        existingGeneration: 3,
      }).success).toBe(true)
      expect(transferCommitResultSchema.safeParse({
        state: "refused",
        transferId,
        reason,
      }).success).toBe(false)
    }
    expect(transferTargetPreflightResultSchema.safeParse({
      allowed: false,
      reason: "session-approval-pending",
    }).success).toBe(false)
  })

  it("prepares a digest-bound manifest idempotently", () => {
    expect(transferPrepareParamsSchema.safeParse({
      manifest,
      manifestDigest: digest("8"),
      client: "desktop",
    }).success).toBe(true)
    for (const state of ["receiving", "prepared", "committed"] as const) {
      const result = state === "receiving"
        ? { state, transferId, missingMemberIds: ["state", "repository"] }
        : state === "prepared"
          ? { state, transferId }
          : {
              state,
              transferId,
              workspacePath: "/worktrees/session-1",
              checkpointCommit: "7".repeat(40),
              ownershipGeneration: 3,
            }
      expect(transferPrepareResultSchema.safeParse(result).success).toBe(true)
    }
  })

  it("streams one declared member at a time", () => {
    expect(transferMemberParamsSchema.safeParse({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: "QUJD",
      final: true,
      client: "desktop",
    }).success).toBe(true)
    expect(transferMemberResultSchema.safeParse({
      state: "receiving",
      transferId,
      memberId: "state",
      nextSequence: 1,
    }).success).toBe(true)
    expect(transferMemberResultSchema.safeParse({
      state: "member-received",
      transferId,
      memberId: "state",
    }).success).toBe(true)
    expect(transferMemberResultSchema.safeParse({
      state: "prepared",
      transferId,
    }).success).toBe(true)
  })

  it("bounds durable member fragments with full non-final chunks", () => {
    const zeroBytesBase64 = (byteLength: number) => (
      `${"AAAA".repeat(Math.floor(byteLength / 3))}${
        byteLength % 3 === 1 ? "AA==" : byteLength % 3 === 2 ? "AAA=" : ""
      }`
    )
    const request = (byteLength: number, final: boolean) => transferMemberParamsSchema.safeParse({
      transferId,
      memberId: "repository",
      sequence: 0,
      bytes: zeroBytesBase64(byteLength),
      final,
      client: "desktop",
    }).success

    expect(request(0, false)).toBe(false)
    expect(request(1, false)).toBe(false)
    expect(request(transferMemberChunkBytes, false)).toBe(true)
    expect(request(1, true)).toBe(true)
  })

  it("commits, queries, and aborts without guessing after a lost acknowledgement", () => {
    expect(transferCommitResultSchema.safeParse({
      state: "refused",
      transferId,
      reason: "target-project-changed",
    }).success).toBe(true)
    expect(transferCommitResultSchema.safeParse({
      state: "committed",
      transferId,
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "7".repeat(40),
      ownershipGeneration: 3,
    }).success).toBe(true)
    expect(transferStatusResultSchema.safeParse({
      state: "recovering",
      transferId,
      stage: "persistence",
    }).success).toBe(true)
    expect(transferStatusResultSchema.safeParse({
      state: "failed",
      transferId,
      reason: "recovery-failed",
    }).success).toBe(true)
    expect(transferAbortResultSchema.safeParse({ state: "aborted", transferId }).success)
      .toBe(true)
    expect(transferAbortResultSchema.safeParse({
      state: "committed",
      transferId,
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "7".repeat(40),
      ownershipGeneration: 3,
    }).success).toBe(true)
  })
})
