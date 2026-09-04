import {
  sessionTransferStateSchema,
  transferCommitResultSchema,
  transferTargetPreflightParamsSchema,
  transferTargetPreflightResultSchema,
  type SessionTransferManifest,
  type SessionTransferUsageRecord,
  type TransferCommitResult,
  type TransferTargetPreflightParams,
  type TransferTargetPreflightResult,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { importSessionTransferState } from "./session-transfer-state.js"
import { FileTransferTransactions } from "./transfer-transactions.js"

type RestoredWorkspace = {
  path: string
  baseCommit: string
}

type TargetWorkspaceOperations = {
  restoreSessionFromBundle?: (
    bundlePath: string,
    sessionId: string,
  ) => Promise<RestoredWorkspace>
  restoreSessionFromRef?: (
    repositoryPath: string,
    remote: string,
    sessionId: string,
    expectedCommit?: string,
  ) => Promise<RestoredWorkspace>
  writeTransferredArtifactSource?: (
    worktreePath: string,
    path: string,
    bytes: Uint8Array,
  ) => Promise<void>
}

type StoredVisualContext = NonNullable<
  WorkspaceSnapshot["annotations"][number]["visualContext"]
>

type TargetAnnotationVisualContext = {
  storeUpload(input: {
    artifactRevision: number
    mimeType: "image/png" | "image/jpeg" | "image/webp"
    bytes: Uint8Array
    width: number
    height: number
  }): Promise<StoredVisualContext>
}

type TargetUsageLedger = {
  replaceTransferredSession(
    sessionId: string,
    records: readonly SessionTransferUsageRecord[],
  ): void
}

type TransferFailureReason = Extract<
  Awaited<ReturnType<FileTransferTransactions["status"]>>,
  { state: "failed" }
>["reason"]

export async function preflightSessionTransferTarget(
  snapshot: WorkspaceSnapshot,
  rawParams: TransferTargetPreflightParams,
  projectHasLineage: (repositoryPath: string, lineageCommit: string) => Promise<boolean>,
): Promise<TransferTargetPreflightResult> {
  const params = transferTargetPreflightParamsSchema.parse(rawParams)
  const existing = snapshot.sessions.find((session) => session.id === params.sessionId)
  if (existing) {
    return transferTargetPreflightResultSchema.parse({
      allowed: false,
      reason: (existing.ownershipGeneration ?? 0) > params.ownershipGeneration
        ? "target-session-newer"
        : "target-session-diverged",
    })
  }
  if (!snapshot.project) {
    return transferTargetPreflightResultSchema.parse({
      allowed: false,
      reason: "target-project-missing",
    })
  }
  if (!await projectHasLineage(snapshot.project.path, params.lineageCommit)) {
    return transferTargetPreflightResultSchema.parse({
      allowed: false,
      reason: "target-project-mismatch",
    })
  }
  return transferTargetPreflightResultSchema.parse({
    allowed: true,
    targetProjectId: snapshot.project.id,
    lineageCommit: params.lineageCommit,
  })
}

function refusal(
  transferId: string,
  reason: Extract<TransferCommitResult, { state: "refused" }>["reason"],
): TransferCommitResult {
  return transferCommitResultSchema.parse({ state: "refused", transferId, reason })
}

function failureReason(stage: "repository" | "state" | "resources" | "persistence"):
TransferFailureReason {
  if (stage === "repository") return "repository-restore-failed"
  if (stage === "state") return "state-import-failed"
  if (stage === "resources") return "resource-import-failed"
  return "persistence-failed"
}

function committedResult(
  manifest: SessionTransferManifest,
  workspacePath: string,
): Extract<TransferCommitResult, { state: "committed" }> {
  return transferCommitResultSchema.parse({
    state: "committed",
    transferId: manifest.transferId,
    workspacePath,
    checkpointCommit: manifest.project.checkpointCommit,
    ownershipGeneration: manifest.ownership.toGeneration,
  }) as Extract<TransferCommitResult, { state: "committed" }>
}

async function restoreRepository(
  snapshot: WorkspaceSnapshot,
  manifest: SessionTransferManifest,
  manifestDigest: string,
  transactions: FileTransferTransactions,
  workspace: TargetWorkspaceOperations,
): Promise<RestoredWorkspace> {
  if (!snapshot.project) throw new Error("The target project is unavailable")
  if (manifest.repository.method === "git-bundle") {
    if (!workspace.restoreSessionFromBundle) {
      throw new Error("This machine cannot restore a transferred Git bundle")
    }
    const bundlePath = await transactions.memberPath(
      manifest.transferId,
      manifestDigest,
      manifest.repository.memberId,
    )
    return workspace.restoreSessionFromBundle(bundlePath, manifest.sessionId)
  }
  if (!workspace.restoreSessionFromRef) {
    throw new Error("This machine cannot restore a transferred Git ref")
  }
  return workspace.restoreSessionFromRef(
    snapshot.project.path,
    manifest.repository.remote,
    manifest.sessionId,
    manifest.repository.commit,
  )
}

async function restoreResources(
  manifest: SessionTransferManifest,
  manifestDigest: string,
  state: ReturnType<typeof sessionTransferStateSchema.parse>,
  workspacePath: string,
  transactions: FileTransferTransactions,
  workspace: TargetWorkspaceOperations,
  annotationVisualContext: TargetAnnotationVisualContext,
): Promise<void> {
  for (const member of manifest.members) {
    if (member.kind === "artifact-source") {
      const artifact = state.artifacts.find((candidate) => candidate.id === member.artifactId)
      if (!artifact?.path || !workspace.writeTransferredArtifactSource) {
        throw new Error("A transferred artifact source has no safe target")
      }
      const bytes = await transactions.readMember(
        manifest.transferId,
        manifestDigest,
        member.memberId,
      )
      await workspace.writeTransferredArtifactSource(workspacePath, artifact.path, bytes)
      continue
    }
    if (member.kind !== "annotation-crop") continue
    const visual = state.annotations
      .map((annotation) => annotation.visualContext)
      .find((candidate) => candidate?.status === "available" && candidate.ref === member.ref)
    if (
      visual?.status !== "available"
      || visual.mimeType !== member.mimeType
      || visual.byteLength !== member.byteLength
    ) {
      throw new Error("A transferred annotation crop has no matching annotation")
    }
    const bytes = await transactions.readMember(
      manifest.transferId,
      manifestDigest,
      member.memberId,
    )
    const stored = await annotationVisualContext.storeUpload({
      artifactRevision: visual.artifactRevision,
      mimeType: visual.mimeType,
      bytes,
      width: visual.width,
      height: visual.height,
    })
    if (
      stored.status !== "available"
      || stored.ref !== visual.ref
      || stored.byteLength !== visual.byteLength
    ) {
      throw new Error("A transferred annotation crop could not be restored exactly")
    }
  }
}

export async function commitPreparedSessionTransfer(input: {
  snapshot: WorkspaceSnapshot
  transferId: string
  manifestDigest: string
  transactions: FileTransferTransactions
  projectHasLineage: (repositoryPath: string, lineageCommit: string) => Promise<boolean>
  workspace: TargetWorkspaceOperations
  annotationVisualContext: TargetAnnotationVisualContext
  usageLedger: TargetUsageLedger
  save: (snapshot: WorkspaceSnapshot) => Promise<void>
  now: () => string
}): Promise<{ snapshot: WorkspaceSnapshot; result: TransferCommitResult }> {
  const current = await input.transactions.status(input.transferId, input.manifestDigest)
  if (current.state === "committed") {
    return { snapshot: input.snapshot, result: transferCommitResultSchema.parse(current) }
  }
  if (current.state === "unknown" || current.state === "receiving") {
    return {
      snapshot: input.snapshot,
      result: refusal(input.transferId, "session-resource-unavailable"),
    }
  }
  if (current.state === "aborted") {
    return {
      snapshot: input.snapshot,
      result: refusal(input.transferId, "session-state-changed"),
    }
  }

  const manifest = await input.transactions.manifest(input.transferId, input.manifestDigest)
  if (manifest.targetMachineId !== input.snapshot.machine.id) {
    return {
      snapshot: input.snapshot,
      result: refusal(input.transferId, "target-project-mismatch"),
    }
  }
  if (!input.snapshot.project) {
    return {
      snapshot: input.snapshot,
      result: refusal(input.transferId, "target-project-missing"),
    }
  }
  if (input.snapshot.project.id !== manifest.project.targetProjectId) {
    return {
      snapshot: input.snapshot,
      result: refusal(input.transferId, "target-project-changed"),
    }
  }
  if (!await input.projectHasLineage(
    input.snapshot.project.path,
    manifest.project.lineageCommit,
  )) {
    return {
      snapshot: input.snapshot,
      result: refusal(input.transferId, "target-project-mismatch"),
    }
  }

  const existing = input.snapshot.sessions.find((session) => session.id === manifest.sessionId)
  if (existing) {
    const exactArrival = existing.transferredFrom?.transferId === manifest.transferId
      && existing.transferredFrom.sourceMachineId === manifest.sourceMachineId
      && existing.transferredFrom.generation === manifest.ownership.toGeneration
      && existing.transferredFrom.checkpointCommit === manifest.project.checkpointCommit
      && existing.workspacePath !== undefined
    if (exactArrival) {
      const result = committedResult(manifest, existing.workspacePath!)
      await input.transactions.markCommitted(input.transferId, input.manifestDigest, result)
      return { snapshot: input.snapshot, result }
    }
    return {
      snapshot: input.snapshot,
      result: refusal(
        input.transferId,
        (existing.ownershipGeneration ?? 0) > manifest.ownership.fromGeneration
          ? "target-session-newer"
          : "target-session-diverged",
      ),
    }
  }

  let stage: "repository" | "state" | "resources" | "persistence" = "repository"
  try {
    await input.transactions.markRecovering(input.transferId, input.manifestDigest, stage)
    const restored = await restoreRepository(
      input.snapshot,
      manifest,
      input.manifestDigest,
      input.transactions,
      input.workspace,
    )
    if (restored.baseCommit !== manifest.project.checkpointCommit) {
      throw new Error("The restored repository does not match the transferred checkpoint")
    }

    stage = "state"
    await input.transactions.markRecovering(input.transferId, input.manifestDigest, stage)
    const stateBytes = await input.transactions.readMember(
      input.transferId,
      input.manifestDigest,
      manifest.stateMemberId,
    )
    const state = sessionTransferStateSchema.parse(JSON.parse(stateBytes.toString("utf8")))
    if (
      state.session.id !== manifest.sessionId
      || state.session.ownershipGeneration !== manifest.ownership.fromGeneration
    ) {
      throw new Error("Transferred session state does not match its manifest")
    }

    stage = "resources"
    await input.transactions.markRecovering(input.transferId, input.manifestDigest, stage)
    await restoreResources(
      manifest,
      input.manifestDigest,
      state,
      restored.path,
      input.transactions,
      input.workspace,
      input.annotationVisualContext,
    )
    input.usageLedger.replaceTransferredSession(manifest.sessionId, state.usage)

    const completedAt = input.now()
    const candidate = importSessionTransferState(input.snapshot, state, {
      sourceMachineId: manifest.sourceMachineId,
      targetProjectId: input.snapshot.project.id,
      workspacePath: restored.path,
      transferId: manifest.transferId,
      manifestDigest: input.manifestDigest,
      ownershipGeneration: manifest.ownership.toGeneration,
      checkpointCommit: manifest.project.checkpointCommit,
      completedAt,
    })

    stage = "persistence"
    await input.transactions.markRecovering(input.transferId, input.manifestDigest, stage)
    await input.save(candidate)
    const result = committedResult(manifest, restored.path)
    await input.transactions.markCommitted(input.transferId, input.manifestDigest, result)
    return { snapshot: candidate, result }
  } catch (error) {
    await input.transactions.markFailed(
      input.transferId,
      input.manifestDigest,
      failureReason(stage),
    ).catch(() => {})
    throw error
  }
}
