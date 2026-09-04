import type { DatabaseSync } from "node:sqlite"

import {
  machineIdSchema,
  projectSchema,
  sessionOwnershipConflictSchema,
  sessionSourceRecoverySchema,
  sessionTransferContractVersionSchema,
  sessionTransferSessionSchema,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { clearWorkingPlanApprovalBlockers } from "./working-plan.js"

const conflictProofBaseSchema = sessionSourceRecoverySchema.pick({}).extend({
  version: sessionTransferContractVersionSchema,
  sessionId: sessionTransferSessionSchema.shape.id,
  sourceMachineId: machineIdSchema,
  sourceProjectId: projectSchema.shape.id,
  workspacePath: projectSchema.shape.path,
  ownershipGeneration: sessionSourceRecoverySchema.shape.generation,
  conflict: sessionOwnershipConflictSchema,
  sourceRecovery: sessionSourceRecoverySchema.optional(),
}).strict()

const currentDetectedTransferConflictSchema = conflictProofBaseSchema
  .superRefine((proof, context) => {
    if (proof.sourceMachineId === proof.conflict.otherMachineId) {
      context.addIssue({
        code: "custom",
        path: ["conflict", "otherMachineId"],
        message: "A detected conflict must name another machine",
      })
    }
    if (proof.conflict.kind === "recovery-contradicted") {
      if (
        !proof.sourceRecovery
        || proof.sourceRecovery.transferId !== proof.conflict.transferId
        || proof.sourceRecovery.targetMachineId !== proof.conflict.otherMachineId
        || proof.sourceRecovery.generation !== proof.ownershipGeneration
        || proof.conflict.otherGeneration <= proof.ownershipGeneration
      ) {
        context.addIssue({
          code: "custom",
          path: ["conflict"],
          message: "A recovered conflict proof must contradict its source recovery claim",
        })
      }
      return
    }
    if (
      proof.sourceRecovery !== undefined
      || (
        proof.conflict.reason === "target-session-newer"
          ? proof.conflict.otherGeneration <= proof.ownershipGeneration
          : proof.conflict.otherGeneration > proof.ownershipGeneration
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["conflict"],
        message: "A direct conflict proof must preserve the target ownership observation",
      })
    }
  })

// Conflict proofs written before direct target evidence existed were flat.
// Preserve those durable safety records by lifting them into the versioned
// nested evidence shape at read time; new writes always use the current shape.
const legacyDetectedTransferConflictSchema = sessionOwnershipConflictSchema.options[0].extend({
  version: sessionTransferContractVersionSchema,
  sessionId: sessionTransferSessionSchema.shape.id,
  sourceMachineId: machineIdSchema,
  sourceProjectId: projectSchema.shape.id,
  workspacePath: projectSchema.shape.path,
  sourceRecovery: sessionSourceRecoverySchema,
}).strict().superRefine((legacy, context) => {
  if (
    legacy.sourceRecovery.transferId !== legacy.transferId
    || legacy.sourceRecovery.targetMachineId !== legacy.otherMachineId
    || legacy.otherGeneration <= legacy.sourceRecovery.generation
  ) {
    context.addIssue({
      code: "custom",
      path: ["transferId"],
      message: "A recovered conflict proof must contradict its source recovery claim",
    })
  }
  if (legacy.sourceMachineId === legacy.otherMachineId) {
    context.addIssue({
      code: "custom",
      path: ["otherMachineId"],
      message: "A detected conflict must name another machine",
    })
  }
}).transform((legacy) => ({
  version: legacy.version,
  sessionId: legacy.sessionId,
  sourceMachineId: legacy.sourceMachineId,
  sourceProjectId: legacy.sourceProjectId,
  workspacePath: legacy.workspacePath,
  ownershipGeneration: legacy.sourceRecovery.generation,
  sourceRecovery: legacy.sourceRecovery,
  conflict: {
    kind: legacy.kind,
    transferId: legacy.transferId,
    otherMachineId: legacy.otherMachineId,
    otherGeneration: legacy.otherGeneration,
    detectedAt: legacy.detectedAt,
    recoveryAction: legacy.recoveryAction,
  },
}))

export const detectedTransferConflictSchema = currentDetectedTransferConflictSchema.or(
  legacyDetectedTransferConflictSchema,
)

export type DetectedTransferConflict = ReturnType<typeof detectedTransferConflictSchema.parse>

type StoredConflict = { proof: string }

// A recovered source deliberately becomes writable before the target has
// confirmed its state. Direct target evidence can likewise arrive before the
// ordinary snapshot save. This machine-wide record is the durable reason that
// source must stay frozen across a failed writer or restart.
export class SqliteTransferConflicts {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS transfer_conflicts (
        transfer_id TEXT PRIMARY KEY,
        source_machine_id TEXT NOT NULL,
        source_project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        proof TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transfer_conflicts_source
        ON transfer_conflicts (source_machine_id, source_project_id, session_id);
    `)
  }

  record(raw: DetectedTransferConflict): void {
    const proof = detectedTransferConflictSchema.parse(raw)
    this.#database
      .prepare(`
        INSERT INTO transfer_conflicts (
          transfer_id, source_machine_id, source_project_id, session_id, proof
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(transfer_id) DO NOTHING
      `)
      .run(
        proof.conflict.transferId,
        proof.sourceMachineId,
        proof.sourceProjectId,
        proof.sessionId,
        JSON.stringify(proof),
      )
    const stored = this.#findByTransferId(proof.conflict.transferId)
    if (!stored || JSON.stringify(stored) !== JSON.stringify(proof)) {
      throw new Error("Transfer conflict proof conflicts with an existing transfer")
    }
  }

  restore(rawSnapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    let snapshot = workspaceSnapshotSchema.parse(rawSnapshot)
    const project = snapshot.project
    if (!project) return snapshot
    const rows = this.#database
      .prepare(`
        SELECT proof FROM transfer_conflicts
        WHERE source_machine_id = ? AND source_project_id = ?
        ORDER BY transfer_id
      `)
      .all(snapshot.machine.id, project.id) as StoredConflict[]
    for (const row of rows) {
      const proof = detectedTransferConflictSchema.parse(JSON.parse(row.proof))
      snapshot = restoreDetectedConflict(snapshot, proof)
    }
    return snapshot
  }

  #findByTransferId(transferId: string): DetectedTransferConflict | undefined {
    const row = this.#database
      .prepare("SELECT proof FROM transfer_conflicts WHERE transfer_id = ?")
      .get(transferId) as StoredConflict | undefined
    if (!row) return undefined
    return detectedTransferConflictSchema.parse(JSON.parse(row.proof))
  }
}

function restoreDetectedConflict(
  snapshot: WorkspaceSnapshot,
  proof: DetectedTransferConflict,
): WorkspaceSnapshot {
  const conflict = proof.conflict
  const current = snapshot.sessions.find((session) => session.id === proof.sessionId)
  if (
    !current
    || current.projectId !== proof.sourceProjectId
    || current.workspacePath !== proof.workspacePath
    || (current.ownershipGeneration ?? 0) !== proof.ownershipGeneration
  ) return snapshot

  // Releasing the source is authoritative canonical state. A retained proof
  // explains how the conflict happened; it must not freeze a resolved session
  // again after journal retention or restart.
  if (
    current.state === "transferred"
    && current.transfer?.phase === "transferred"
    && current.transfer.completion === "conflict-released"
    && current.transfer.transferId === conflict.transferId
    && current.transfer.targetMachineId === conflict.otherMachineId
    && current.transfer.generation === conflict.otherGeneration
  ) return snapshot

  if (
    current.state === "ownership-conflict"
    && JSON.stringify(current.ownershipConflict) === JSON.stringify(conflict)
  ) return snapshot

  if (conflict.kind === "recovery-contradicted") {
    if (JSON.stringify(current.sourceRecovery) !== JSON.stringify(proof.sourceRecovery)) {
      return snapshot
    }
  } else {
    const lifecycle = current.transfer
    if (
      current.state !== "transferring"
      || lifecycle?.phase !== "transferring"
      || lifecycle.transferId !== conflict.transferId
      || lifecycle.targetMachineId !== conflict.otherMachineId
      || lifecycle.package.state !== "staged"
      || lifecycle.package.manifestDigest !== conflict.manifestDigest
    ) return snapshot
  }

  const candidate = structuredClone(snapshot)
  const session = candidate.sessions.find((entry) => entry.id === proof.sessionId)!
  session.state = "ownership-conflict"
  session.updatedAt = conflict.detectedAt
  session.ownershipConflict = conflict
  if (conflict.kind === "target-session-detected") delete session.transfer
  delete session.activeTurnId
  delete session.providerThreadId
  delete session.providerFailure

  const removedApprovalIds = new Set(candidate.approvals.flatMap((approval) => (
    approval.sessionId === session.id ? [approval.id] : []
  )))
  candidate.approvals = candidate.approvals.filter(
    (approval) => !removedApprovalIds.has(approval.id),
  )
  candidate.workingPlans = clearWorkingPlanApprovalBlockers(
    candidate.workingPlans,
    removedApprovalIds,
    conflict.detectedAt,
  ).plans
  candidate.thread.push({
    id: `system-transfer-conflict-restored-${conflict.transferId}`,
    sessionId: session.id,
    kind: "system",
    body: "Session ownership conflict restored.",
    detail: `Machine ${conflict.otherMachineId} holds ownership generation ${conflict.otherGeneration}. This source remains read-only because the conflict proof survived a failed snapshot write.`,
    createdAt: conflict.detectedAt,
  })
  return workspaceSnapshotSchema.parse(candidate)
}
