import { randomUUID } from "node:crypto"

import {
  sessionTransferStateSchema,
  workspaceSnapshotSchema,
  type SessionTransferContractRefusal,
  type SessionTransferState,
  type SessionTransferUsageRecord,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { redactWorkspaceCopies } from "./workspace-redaction.js"

export class SessionTransferStateError extends Error {
  readonly reason: SessionTransferContractRefusal

  constructor(reason: SessionTransferContractRefusal) {
    super(reason)
    this.name = "SessionTransferStateError"
    this.reason = reason
  }
}

export function portableSessionTransferState(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  usage: readonly SessionTransferUsageRecord[],
): SessionTransferState {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new SessionTransferStateError("session-state-invalid")
  if (session.state === "transferred") {
    throw new SessionTransferStateError("session-not-owned")
  }
  if (session.state === "transferring") {
    throw new SessionTransferStateError("session-transfer-in-progress")
  }
  if (snapshot.approvals.some((approval) => approval.sessionId === sessionId)) {
    throw new SessionTransferStateError("session-approval-pending")
  }
  if (!session.baseCommit || !/^[a-f0-9]{40}$/u.test(session.baseCommit)) {
    throw new SessionTransferStateError("session-base-commit-missing")
  }

  const durable = redactWorkspaceCopies(snapshot)
  const durableSession = durable.sessions.find((candidate) => candidate.id === sessionId)!
  const workingPlan = durable.workingPlans.find((plan) => plan.sessionId === sessionId)
  const portablePlan = workingPlan === undefined
    ? undefined
    : (({ providerSync: _providerSync, ...plan }) => plan)(workingPlan)
  const state = {
    version: 1 as const,
    session: {
      id: durableSession.id,
      title: durableSession.title,
      runtime: {
        provider: durableSession.runtime.provider,
        model: durableSession.runtime.model,
        reasoning: durableSession.runtime.reasoning,
        permissionMode: durableSession.runtime.permissionMode,
      },
      changedFiles: durableSession.changedFiles,
      testsPassed: durableSession.testsPassed,
      testsFailed: durableSession.testsFailed,
      updatedAt: durableSession.updatedAt,
      baseCommit: durableSession.baseCommit!,
      ownershipGeneration: durableSession.ownershipGeneration ?? 0,
      ...(durableSession.forkedFrom ? {
        forkedFrom: {
          ...durableSession.forkedFrom,
          sourceMachineId: durableSession.forkedFrom.sourceMachineId ?? snapshot.machine.id,
        },
      } : {}),
    },
    thread: durable.thread.filter((item) => item.sessionId === sessionId),
    artifacts: durable.artifacts.filter((artifact) => artifact.sessionId === sessionId),
    ...(portablePlan ? { workingPlan: portablePlan } : {}),
    annotations: durable.annotations.filter((annotation) => annotation.sessionId === sessionId),
    usage: [...usage],
  }
  const parsed = sessionTransferStateSchema.safeParse(state)
  if (!parsed.success) throw new SessionTransferStateError("session-state-invalid")
  return parsed.data
}

export function importSessionTransferState(
  snapshot: WorkspaceSnapshot,
  transferred: SessionTransferState,
  input: {
    sourceMachineId: string
    targetProjectId: string
    workspacePath: string
    transferId: string
    ownershipGeneration: number
    completedAt: string
  },
): WorkspaceSnapshot {
  const state = sessionTransferStateSchema.parse(transferred)
  if (!snapshot.project || snapshot.project.id !== input.targetProjectId) {
    throw new SessionTransferStateError("target-project-missing")
  }
  if (snapshot.sessions.some((session) => session.id === state.session.id)) {
    throw new SessionTransferStateError("target-session-diverged")
  }
  if (input.ownershipGeneration !== state.session.ownershipGeneration + 1) {
    throw new SessionTransferStateError("session-state-invalid")
  }

  const candidate = structuredClone(snapshot)
  candidate.sessions.push({
    id: state.session.id,
    projectId: input.targetProjectId,
    title: state.session.title,
    state: "idle",
    runtime: { ...state.session.runtime, auto: false },
    changedFiles: state.session.changedFiles,
    testsPassed: state.session.testsPassed,
    testsFailed: state.session.testsFailed,
    updatedAt: input.completedAt,
    workspacePath: input.workspacePath,
    baseCommit: state.session.baseCommit,
    ownershipGeneration: input.ownershipGeneration,
    ...(state.session.forkedFrom ? { forkedFrom: state.session.forkedFrom } : {}),
  })
  candidate.thread.push(...state.thread, {
    id: `system-transfer-${randomUUID()}`,
    sessionId: state.session.id,
    kind: "system",
    body: "Transferred from another machine.",
    detail: `Session state moved from ${input.sourceMachineId}. Native provider state, machine authority, and automatic execution did not transfer.`,
    createdAt: input.completedAt,
  })
  candidate.artifacts.push(...state.artifacts)
  if (state.workingPlan) candidate.workingPlans.push(state.workingPlan)
  candidate.annotations.push(...state.annotations)
  candidate.activeSessionId = state.session.id

  const parsed = workspaceSnapshotSchema.safeParse(candidate)
  if (!parsed.success) throw new SessionTransferStateError("session-state-invalid")
  return parsed.data
}
