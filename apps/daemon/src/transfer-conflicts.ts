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

export const detectedTransferConflictSchema = sessionOwnershipConflictSchema.extend({
  version: sessionTransferContractVersionSchema,
  sessionId: sessionTransferSessionSchema.shape.id,
  sourceMachineId: machineIdSchema,
  sourceProjectId: projectSchema.shape.id,
  workspacePath: projectSchema.shape.path,
  sourceRecovery: sessionSourceRecoverySchema,
}).strict().superRefine((proof, context) => {
  if (
    proof.sourceRecovery.transferId !== proof.transferId
    || proof.sourceRecovery.targetMachineId !== proof.otherMachineId
    || proof.otherGeneration <= proof.sourceRecovery.generation
  ) {
    context.addIssue({
      code: "custom",
      path: ["transferId"],
      message: "A detected conflict must contradict its source recovery claim",
    })
  }
  if (proof.sourceMachineId === proof.otherMachineId) {
    context.addIssue({
      code: "custom",
      path: ["otherMachineId"],
      message: "A detected conflict must name another machine",
    })
  }
})

export type DetectedTransferConflict = ReturnType<typeof detectedTransferConflictSchema.parse>

type StoredConflict = { proof: string }

// A recovered source deliberately becomes writable before the target has
// confirmed its state. Once the target later proves it committed the move,
// this machine-wide record is the durable reason that source must stay frozen.
// It is written before the ordinary snapshot save so a failed async writer or
// a restart cannot turn a proven duplicate owner writable again.
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
        proof.transferId,
        proof.sourceMachineId,
        proof.sourceProjectId,
        proof.sessionId,
        JSON.stringify(proof),
      )
    const stored = this.#findByTransferId(proof.transferId)
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
  const current = snapshot.sessions.find((session) => session.id === proof.sessionId)
  if (
    !current
    || current.projectId !== proof.sourceProjectId
    || current.workspacePath !== proof.workspacePath
    || current.ownershipGeneration !== proof.sourceRecovery.generation
    || JSON.stringify(current.sourceRecovery) !== JSON.stringify(proof.sourceRecovery)
  ) return snapshot
  if (
    current.state === "ownership-conflict"
    && current.ownershipConflict?.transferId === proof.transferId
    && current.ownershipConflict.otherMachineId === proof.otherMachineId
    && current.ownershipConflict.otherGeneration === proof.otherGeneration
    && current.ownershipConflict.detectedAt === proof.detectedAt
  ) return snapshot

  const candidate = structuredClone(snapshot)
  const session = candidate.sessions.find((entry) => entry.id === proof.sessionId)!
  session.state = "ownership-conflict"
  session.updatedAt = proof.detectedAt
  session.ownershipConflict = {
    transferId: proof.transferId,
    otherMachineId: proof.otherMachineId,
    otherGeneration: proof.otherGeneration,
    detectedAt: proof.detectedAt,
    recoveryAction: proof.recoveryAction,
  }
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
    proof.detectedAt,
  ).plans
  candidate.thread.push({
    id: `system-transfer-conflict-restored-${proof.transferId}`,
    sessionId: session.id,
    kind: "system",
    body: "Session ownership conflict restored.",
    detail: `Machine ${proof.otherMachineId} holds ownership generation ${proof.otherGeneration}. This source remains read-only because the conflict proof survived a failed snapshot write.`,
    createdAt: proof.detectedAt,
  })
  return workspaceSnapshotSchema.parse(candidate)
}
