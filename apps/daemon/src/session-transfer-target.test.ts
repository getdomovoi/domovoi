import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createEmptyWorkspace,
  demoWorkspace,
  type SessionTransferUsageRecord,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import {
  createSessionTransferPackage,
  prepareSessionTransferIntent,
} from "./session-transfer-package.js"
import {
  commitPreparedSessionTransfer,
  preflightSessionTransferTarget,
} from "./session-transfer-target.js"
import { FileTransferTransactions } from "./transfer-transactions.js"

const scratchDirectories: string[] = []
const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`
const baseCommit = "c".repeat(40)
const checkpointCommit = "d".repeat(40)
const cropRef = `crop-${"e".repeat(64)}`

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

function targetWorkspace(): WorkspaceSnapshot {
  const snapshot = createEmptyWorkspace({
    ...demoWorkspace.machine,
    id: targetMachineId,
    name: "target",
  })
  snapshot.project = {
    ...demoWorkspace.project!,
    id: "project-target",
    machineId: targetMachineId,
    path: "/target/project",
  }
  return snapshot
}

describe("target transfer preflight", () => {
  const params = {
    contractVersion: 1 as const,
    sessionId: "session-1",
    sourceMachineId,
    sourceProjectId: "project-source",
    lineageCommit: baseCommit,
    ownershipGeneration: 2,
    method: "git-bundle" as const,
    coverage: { included: [], excluded: [], warnings: [] },
    initiatedByClient: "desktop" as const,
  }

  const capabilities = {
    verifyLineage: true,
    restoreGitBundle: true,
    restoreGitRef: true,
    importArtifactSources: true,
    importUsage: true,
    persistOwnership: true,
  }

  it("requires the open target project to share the source lineage", async () => {
    const workspace = targetWorkspace()
    const projectHasLineage = vi.fn(async () => true)
    await expect(preflightSessionTransferTarget(workspace, params, projectHasLineage, capabilities))
      .resolves.toEqual({
        allowed: true,
        targetProjectId: "project-target",
        lineageCommit: baseCommit,
      })
    expect(projectHasLineage).toHaveBeenCalledWith("/target/project", baseCommit)

    projectHasLineage.mockResolvedValue(false)
    await expect(preflightSessionTransferTarget(workspace, params, projectHasLineage, capabilities))
      .resolves.toEqual({ allowed: false, reason: "target-project-mismatch" })
    workspace.project = null
    await expect(preflightSessionTransferTarget(workspace, params, projectHasLineage, capabilities))
      .resolves.toEqual({ allowed: false, reason: "target-project-missing" })
  })

  it("refuses any independently owned copy of the same session", async () => {
    const workspace = targetWorkspace()
    workspace.sessions.push({
      ...demoWorkspace.sessions[2]!,
      id: "session-1",
      projectId: "project-target",
      ownershipGeneration: 3,
    })
    await expect(preflightSessionTransferTarget(workspace, params, async () => true, capabilities))
      .resolves.toEqual({
        allowed: false,
        reason: "target-session-newer",
        existingGeneration: 3,
      })
    workspace.sessions[0]!.ownershipGeneration = 1
    await expect(preflightSessionTransferTarget(workspace, params, async () => true, capabilities))
      .resolves.toEqual({
        allowed: false,
        reason: "target-session-diverged",
        existingGeneration: 1,
      })
  })

  it("refuses before transfer when the target cannot commit the declared payload", async () => {
    const workspace = targetWorkspace()
    const cases = [
      ["verifyLineage", "target-lineage-check-unavailable"],
      ["restoreGitBundle", "target-bundle-restore-unavailable"],
      ["importUsage", "target-usage-import-unavailable"],
      ["persistOwnership", "target-state-persistence-unavailable"],
    ] as const
    for (const [capability, reason] of cases) {
      await expect(preflightSessionTransferTarget(
        workspace,
        params,
        async () => true,
        { ...capabilities, [capability]: false },
      )).resolves.toEqual({ allowed: false, reason })
    }
    await expect(preflightSessionTransferTarget(
      workspace,
      { ...params, method: "remote-ref" },
      async () => true,
      { ...capabilities, restoreGitRef: false },
    )).resolves.toEqual({ allowed: false, reason: "target-ref-restore-unavailable" })
    await expect(preflightSessionTransferTarget(
      workspace,
      {
        ...params,
        coverage: {
          included: [{ kind: "artifact-sources", count: 1 }],
          excluded: [],
          warnings: [],
        },
      },
      async () => true,
      { ...capabilities, importArtifactSources: false },
    )).resolves.toEqual({ allowed: false, reason: "target-artifact-import-unavailable" })
  })
})

async function preparedTransfer(options: { malformedState?: boolean } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-target-transfer-"))
  scratchDirectories.push(scratch)
  const source = structuredClone(demoWorkspace)
  source.machine.id = sourceMachineId
  source.project!.machineId = sourceMachineId
  const session = source.sessions.find((candidate) => candidate.id === "session-billing")!
  session.state = "idle"
  session.workspacePath = "/source/session-billing"
  session.baseCommit = baseCommit
  session.ownershipGeneration = 2
  source.approvals = []
  const artifact = source.artifacts.find((candidate) => candidate.id === "artifact-preview")!
  artifact.path = "previews/preview.html"
  artifact.mimeType = "text/html"
  const annotation = source.annotations.find((candidate) => candidate.artifactId === artifact.id)!
  annotation.visualContext = {
    status: "available",
    ref: cropRef,
    artifactRevision: artifact.revision,
    mimeType: "image/png",
    width: 32,
    height: 16,
    byteLength: 8,
  }
  const usage: SessionTransferUsageRecord[] = [{
    turnId: "turn-1",
    provider: "claude-code",
    model: "claude-opus-5",
    inputTokens: 4,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    totalTokens: 6,
    costSource: "unavailable",
  }]
  const intent = await prepareSessionTransferIntent({
    snapshot: source,
    sessionId: session.id,
    usage,
    sourceMachineId,
    targetMachineId,
    sourceProjectId: source.project!.id,
    targetProjectId: "project-target",
    lineageCommit: baseCommit,
    sourceHeadCommit: baseCommit,
    worktreeDigest: `sha256:${"f".repeat(64)}`,
    method: "git-bundle",
    readIgnoredArtifactSource: async () => Buffer.from("<h1>preview</h1>\n"),
    readAnnotationCrop: async () => Buffer.from("pngbytes"),
  })
  if (options.malformedState) Reflect.deleteProperty(intent.state, "thread")
  const packaged = createSessionTransferPackage(intent, {
    transferId: `transfer-${"1".repeat(32)}`,
    checkpointCommit,
    repository: { method: "git-bundle", bytes: Buffer.from("repository") },
    createdAt: "2026-09-03T21:00:00.000Z",
  })
  const transactions = new FileTransferTransactions(join(scratch, "transactions"))
  await transactions.prepare(packaged.manifest, packaged.manifestDigest)
  for (const entry of packaged.members) {
    await transactions.acceptMember({
      transferId: packaged.manifest.transferId,
      memberId: entry.member.memberId,
      sequence: 0,
      bytes: entry.bytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })
  }
  return { packaged, transactions, usage }
}

describe("target transfer commit", () => {
  it("validates portable state before restoring repository bytes", async () => {
    const { packaged, transactions } = await preparedTransfer({ malformedState: true })
    const restoreSessionFromBundle = vi.fn(async () => ({
      path: "/target/session-billing",
      branch: "domovoi/session-billing",
      baseCommit: checkpointCommit,
    }))

    await expect(commitPreparedSessionTransfer({
      snapshot: targetWorkspace(),
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      transactions,
      projectHasLineage: async () => true,
      workspace: { restoreSessionFromBundle },
      annotationVisualContext: { storeUpload: vi.fn() },
      usageLedger: { replaceTransferredSession: vi.fn() },
      save: vi.fn(),
      now: () => "2026-09-03T21:01:00.000Z",
    })).rejects.toThrow()

    expect(restoreSessionFromBundle).not.toHaveBeenCalled()
    await expect(transactions.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toEqual({
      state: "failed",
      transferId: packaged.manifest.transferId,
      reason: "state-import-failed",
    })
  })

  it("restores every resource before publishing one runnable target session", async () => {
    const { packaged, transactions, usage } = await preparedTransfer()
    const restoreSessionFromBundle = vi.fn(async () => ({
      path: "/target/session-billing",
      branch: "domovoi/session-billing",
      baseCommit: checkpointCommit,
    }))
    const writeTransferredArtifactSource = vi.fn(async () => {})
    const storeUpload = vi.fn(async (input: {
      artifactRevision: number
      mimeType: "image/png"
      bytes: Uint8Array
      width: number
      height: number
    }) => ({
      status: "available" as const,
      ref: cropRef,
      artifactRevision: input.artifactRevision,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      byteLength: input.bytes.byteLength,
    }))
    const replaceTransferredSession = vi.fn()
    const save = vi.fn(async () => {})

    const committed = await commitPreparedSessionTransfer({
      snapshot: targetWorkspace(),
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      transactions,
      projectHasLineage: async () => true,
      workspace: {
        restoreSessionFromBundle,
        writeTransferredArtifactSource,
      },
      annotationVisualContext: { storeUpload },
      usageLedger: { replaceTransferredSession },
      save,
      now: () => "2026-09-03T21:01:00.000Z",
    })

    expect(committed.result).toEqual({
      state: "committed",
      transferId: packaged.manifest.transferId,
      workspacePath: "/target/session-billing",
      checkpointCommit,
      ownershipGeneration: 3,
    })
    expect(restoreSessionFromBundle).toHaveBeenCalledWith(
      expect.any(String),
      "session-billing",
      {
        repositoryPath: "/target/project",
        checkpointCommits: ["7".repeat(40), checkpointCommit],
      },
    )
    expect(writeTransferredArtifactSource).toHaveBeenCalledWith(
      "/target/session-billing",
      "previews/preview.html",
      expect.any(Uint8Array),
    )
    expect(storeUpload).toHaveBeenCalledWith(expect.objectContaining({
      artifactRevision: 2,
      mimeType: "image/png",
    }))
    expect(replaceTransferredSession).toHaveBeenCalledWith("session-billing", usage)
    expect(save).toHaveBeenCalledOnce()
    expect(committed.snapshot.sessions[0]).toMatchObject({
      id: "session-billing",
      state: "idle",
      ownershipGeneration: 3,
      baseCommit: checkpointCommit,
      runtime: { auto: false },
      transferredFrom: {
        transferId: packaged.manifest.transferId,
        sourceMachineId,
        checkpointCommit,
      },
    })
    await expect(transactions.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toEqual(committed.result)

    await commitPreparedSessionTransfer({
      snapshot: committed.snapshot,
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      transactions,
      projectHasLineage: async () => true,
      workspace: { restoreSessionFromBundle, writeTransferredArtifactSource },
      annotationVisualContext: { storeUpload },
      usageLedger: { replaceTransferredSession },
      save,
      now: () => "2026-09-03T21:02:00.000Z",
    })
    expect(restoreSessionFromBundle).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()

    const failed = await preparedTransfer()
    await failed.transactions.markFailed(
      failed.packaged.manifest.transferId,
      failed.packaged.manifestDigest,
      "persistence-failed",
    )
    const digestCollision = structuredClone(committed.snapshot)
    digestCollision.sessions[0]!.transferredFrom!.manifestDigest = `sha256:${"9".repeat(64)}`
    await expect(commitPreparedSessionTransfer({
      snapshot: digestCollision,
      transferId: failed.packaged.manifest.transferId,
      manifestDigest: failed.packaged.manifestDigest,
      transactions: failed.transactions,
      projectHasLineage: async () => true,
      workspace: { restoreSessionFromBundle, writeTransferredArtifactSource },
      annotationVisualContext: { storeUpload },
      usageLedger: { replaceTransferredSession },
      save,
      now: () => "2026-09-03T21:03:00.000Z",
    })).resolves.toMatchObject({
      result: {
        state: "refused",
        reason: "target-session-newer",
        existingGeneration: 3,
      },
    })
  })

  it("rechecks the digest-bound target project and lineage before recovery", async () => {
    const { packaged, transactions } = await preparedTransfer()
    const changedTarget = targetWorkspace()
    changedTarget.project!.id = "project-other"
    const restoreSessionFromBundle = vi.fn()
    const common = {
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      transactions,
      workspace: { restoreSessionFromBundle },
      annotationVisualContext: { storeUpload: vi.fn() },
      usageLedger: { replaceTransferredSession: vi.fn() },
      save: vi.fn(),
      now: () => "2026-09-03T21:01:00.000Z",
    }

    await expect(commitPreparedSessionTransfer({
      ...common,
      snapshot: changedTarget,
      projectHasLineage: async () => true,
    })).resolves.toMatchObject({
      result: { state: "refused", reason: "target-project-changed" },
    })
    await expect(commitPreparedSessionTransfer({
      ...common,
      snapshot: targetWorkspace(),
      projectHasLineage: async () => false,
    })).resolves.toMatchObject({
      result: { state: "refused", reason: "target-project-mismatch" },
    })
    expect(restoreSessionFromBundle).not.toHaveBeenCalled()
  })

  it("leaves a durable failed status when persistence cannot publish the session", async () => {
    const { packaged, transactions } = await preparedTransfer()
    await expect(commitPreparedSessionTransfer({
      snapshot: targetWorkspace(),
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      transactions,
      projectHasLineage: async () => true,
      workspace: {
        restoreSessionFromBundle: async () => ({
          path: "/target/session-billing",
          branch: "domovoi/session-billing",
          baseCommit: checkpointCommit,
        }),
        writeTransferredArtifactSource: async () => {},
      },
      annotationVisualContext: {
        storeUpload: async (input) => ({
          status: "available",
          ref: cropRef,
          artifactRevision: input.artifactRevision,
          mimeType: input.mimeType,
          width: input.width,
          height: input.height,
          byteLength: input.bytes.byteLength,
        }),
      },
      usageLedger: { replaceTransferredSession: () => {} },
      save: async () => { throw new Error("disk full") },
      now: () => "2026-09-03T21:01:00.000Z",
    })).rejects.toThrow("disk full")
    await expect(transactions.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toEqual({
      state: "failed",
      transferId: packaged.manifest.transferId,
      reason: "persistence-failed",
    })
  })
})
