import { randomUUID } from "node:crypto"

import {
  transferCommitResultSchema,
  transferMemberResultSchema,
  transferPrepareResultSchema,
  transferStatusResultSchema,
  workspaceSnapshotSchema,
  type ClientKind,
  type SessionTransferManifest,
  type TransferCommitResult,
  type TransferMemberResult,
  type TransferPrepareResult,
  type TransferStatusResult,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import {
  sessionTransferManifestDigest,
  type PackagedSessionTransfer,
  type PreparedSessionTransferIntent,
} from "./session-transfer-package.js"
import { SessionTransferStateError } from "./session-transfer-state.js"
import { FileTransferTransactions } from "./transfer-transactions.js"

const transferMemberChunkBytes = 262_144

type CommittedTransfer = Extract<TransferStatusResult, { state: "committed" }>
type RemoteTransferResult =
  | TransferStatusResult
  | TransferPrepareResult
  | TransferMemberResult
  | TransferCommitResult
type Session = WorkspaceSnapshot["sessions"][number]
type TransferringLifecycle = Extract<NonNullable<Session["transfer"]>, {
  phase: "transferring"
}>
type FrozenSourceSession = Session & {
  state: "transferring"
  transfer: TransferringLifecycle
}

function sourceSession(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
): WorkspaceSnapshot["sessions"][number] {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new SessionTransferStateError("session-state-invalid")
  return session
}

export function freezeSourceSessionTransfer(
  snapshot: WorkspaceSnapshot,
  intent: PreparedSessionTransferIntent,
  transferId: string,
  startedAt: string,
  requestedBy: { client: ClientKind; clientId?: string },
): WorkspaceSnapshot {
  const session = sourceSession(snapshot, intent.state.session.id)
  const resumeState = session.state
  if (
    intent.preview.sourceMachineId !== snapshot.machine.id
    || intent.preview.targetMachineId === snapshot.machine.id
    || intent.preview.project.sourceProjectId !== snapshot.project?.id
    || (resumeState !== "idle" && resumeState !== "done" && resumeState !== "failed")
    || session.activeTurnId !== undefined
    || !session.workspacePath
    || session.baseCommit !== intent.state.session.baseCommit
    || (session.ownershipGeneration ?? 0) !== intent.state.session.ownershipGeneration
  ) {
    throw new SessionTransferStateError("session-state-changed")
  }

  const candidate = structuredClone(snapshot)
  const frozen = sourceSession(candidate, session.id)
  frozen.state = "transferring"
  frozen.transfer = {
    phase: "transferring",
    transferId,
    targetMachineId: intent.preview.targetMachineId,
    intentDigest: intent.preview.intentDigest,
    nextGeneration: intent.state.session.ownershipGeneration + 1,
    startedAt,
    resumeState,
    method: intent.method,
    requestedBy,
    package: { state: "preparing" },
  }
  return workspaceSnapshotSchema.parse(candidate)
}

export function stageSourceSessionCheckpoint(
  snapshot: WorkspaceSnapshot,
  manifest: SessionTransferManifest,
): WorkspaceSnapshot {
  const session = sourceSession(snapshot, manifest.sessionId)
  if (
    session.state !== "transferring"
    || session.transfer?.phase !== "transferring"
    || session.transfer.transferId !== manifest.transferId
    || session.transfer.targetMachineId !== manifest.targetMachineId
    || session.transfer.intentDigest !== manifest.intentDigest
    || session.transfer.nextGeneration !== manifest.ownership.toGeneration
    || (session.ownershipGeneration ?? 0) !== manifest.ownership.fromGeneration
    || snapshot.machine.id !== manifest.sourceMachineId
    || snapshot.project?.id !== manifest.project.sourceProjectId
  ) {
    throw new SessionTransferStateError("session-state-changed")
  }

  const candidate = structuredClone(snapshot)
  const staged = sourceSession(candidate, manifest.sessionId)
  staged.baseCommit = manifest.project.checkpointCommit
  if (staged.transfer?.phase !== "transferring") {
    throw new SessionTransferStateError("session-state-changed")
  }
  staged.transfer.package = {
    state: "staged",
    manifestDigest: sessionTransferManifestDigest(manifest),
  }
  return workspaceSnapshotSchema.parse(candidate)
}

export function completeSourceSessionTransfer(
  snapshot: WorkspaceSnapshot,
  committed: CommittedTransfer,
  completedAt: string,
): WorkspaceSnapshot {
  const session = snapshot.sessions.find((candidate) => (
    candidate.transfer?.transferId === committed.transferId
  ))
  if (
    !session
    || session.state !== "transferring"
    || session.transfer?.phase !== "transferring"
    || session.transfer.package.state !== "staged"
    || session.transfer.nextGeneration !== committed.ownershipGeneration
    || session.baseCommit !== committed.checkpointCommit
  ) {
    throw new SessionTransferStateError("session-state-changed")
  }

  const candidate = structuredClone(snapshot)
  const completed = sourceSession(candidate, session.id)
  completed.state = "transferred"
  completed.ownershipGeneration = committed.ownershipGeneration
  completed.runtime.auto = false
  completed.updatedAt = completedAt
  completed.transfer = {
    phase: "transferred",
    transferId: committed.transferId,
    targetMachineId: session.transfer.targetMachineId,
    generation: committed.ownershipGeneration,
    manifestDigest: session.transfer.package.manifestDigest,
    completedAt,
  }
  delete completed.providerThreadId
  delete completed.providerFailure
  return workspaceSnapshotSchema.parse(candidate)
}

function frozenSourceSession(
  snapshot: WorkspaceSnapshot,
  transferId: string,
  sessionId?: string,
): FrozenSourceSession {
  const session = snapshot.sessions.find((candidate) => (
    candidate.transfer?.transferId === transferId
    && (sessionId === undefined || candidate.id === sessionId)
  ))
  if (session?.state !== "transferring" || session.transfer?.phase !== "transferring") {
    throw new SessionTransferStateError("session-state-changed")
  }
  return session as FrozenSourceSession
}

export function thawSourceSessionTransfer(
  snapshot: WorkspaceSnapshot,
  transferId: string,
  thawedAt: string,
): WorkspaceSnapshot {
  const frozen = frozenSourceSession(snapshot, transferId)
  const candidate = structuredClone(snapshot)
  const session = sourceSession(candidate, frozen.id)
  if (session.transfer?.phase !== "transferring") {
    throw new SessionTransferStateError("session-state-changed")
  }
  session.state = session.transfer.resumeState
  session.updatedAt = thawedAt
  delete session.transfer
  return workspaceSnapshotSchema.parse(candidate)
}

export function recoverUnconfirmedSourceTransfer(
  snapshot: WorkspaceSnapshot,
  input: {
    sessionId: string
    transferId: string
    client: ClientKind
    clientId?: string
    recoveredAt: string
  },
): WorkspaceSnapshot {
  const frozen = frozenSourceSession(snapshot, input.transferId, input.sessionId)
  if (frozen.transfer.package.state !== "staged") {
    throw new SessionTransferStateError("session-state-changed")
  }
  const targetMachineId = frozen.transfer.targetMachineId
  const generation = frozen.ownershipGeneration ?? 0
  const manifestDigest = frozen.transfer.package.manifestDigest
  const candidate = thawSourceSessionTransfer(snapshot, input.transferId, input.recoveredAt)
  const recovered = sourceSession(candidate, input.sessionId)
  recovered.sourceRecovery = {
    transferId: input.transferId,
    targetMachineId,
    generation,
    manifestDigest,
    recoveredAt: input.recoveredAt,
    decidedBy: {
      client: input.client,
      ...(input.clientId ? { clientId: input.clientId } : {}),
    },
  }
  candidate.thread.push({
    id: `system-transfer-recovery-${randomUUID()}`,
    sessionId: recovered.id,
    kind: "system",
    body: "Source ownership recovered without target confirmation.",
    detail: `The ${input.client} client confirmed that machine ${targetMachineId} does not hold this session. If that claim was wrong, both machines may contain live work and Domovoi will stop this source when it detects the conflict.`,
    createdAt: input.recoveredAt,
  })
  return workspaceSnapshotSchema.parse(candidate)
}

export function clearConfirmedSourceRecovery(
  snapshot: WorkspaceSnapshot,
  input: {
    sessionId: string
    transferId: string
    targetMachineId: string
    confirmedAt: string
  },
): WorkspaceSnapshot {
  const current = sourceSession(snapshot, input.sessionId)
  const recovery = current.sourceRecovery
  if (
    !recovery
    || recovery.transferId !== input.transferId
    || recovery.targetMachineId !== input.targetMachineId
    || current.state === "ownership-conflict"
  ) {
    throw new SessionTransferStateError("session-state-changed")
  }
  const candidate = structuredClone(snapshot)
  const session = sourceSession(candidate, input.sessionId)
  delete session.sourceRecovery
  session.updatedAt = input.confirmedAt
  candidate.thread.push({
    id: `system-transfer-recovery-cleared-${randomUUID()}`,
    sessionId: session.id,
    kind: "system",
    body: "Target confirmed it does not own this session.",
    detail: `Machine ${input.targetMachineId} has no committed record for transfer ${input.transferId}. The recovery claim is resolved and this session may move again.`,
    createdAt: input.confirmedAt,
  })
  return workspaceSnapshotSchema.parse(candidate)
}

export function markSourceOwnershipConflict(
  snapshot: WorkspaceSnapshot,
  input: {
    sessionId: string
    transferId: string
    otherMachineId: string
    otherGeneration: number
    detectedAt: string
  },
): WorkspaceSnapshot {
  const current = sourceSession(snapshot, input.sessionId)
  const recovery = current.sourceRecovery
  if (
    !recovery
    || recovery.transferId !== input.transferId
    || recovery.targetMachineId !== input.otherMachineId
    || input.otherGeneration <= (current.ownershipGeneration ?? 0)
  ) {
    throw new SessionTransferStateError("session-state-changed")
  }
  const candidate = structuredClone(snapshot)
  const session = sourceSession(candidate, input.sessionId)
  // The machine that made the unverified claim stops. The target did not take
  // that risk and remains usable. This worktree stays intact because it may be
  // the only copy of work created after the mistaken recovery.
  session.state = "ownership-conflict"
  session.updatedAt = input.detectedAt
  session.ownershipConflict = {
    transferId: input.transferId,
    otherMachineId: input.otherMachineId,
    otherGeneration: input.otherGeneration,
    detectedAt: input.detectedAt,
    recoveryAction: "none",
  }
  delete session.activeTurnId
  delete session.providerThreadId
  delete session.providerFailure
  candidate.thread.push({
    id: `system-transfer-conflict-${randomUUID()}`,
    sessionId: session.id,
    kind: "system",
    body: "Session ownership conflict detected.",
    detail: `Machine ${input.otherMachineId} holds ownership generation ${input.otherGeneration}. This source is read-only and its recovery worktree is preserved until a person chooses which work to keep.`,
    createdAt: input.detectedAt,
  })
  return workspaceSnapshotSchema.parse(candidate)
}

async function stageMember(
  transactions: FileTransferTransactions,
  transferId: string,
  memberId: string,
  bytes: Buffer,
): Promise<void> {
  if (bytes.byteLength === 0) {
    const result = await transactions.acceptMember({
      transferId,
      memberId,
      sequence: 0,
      bytes: "",
      final: true,
      client: "desktop",
    })
    if (result.state === "refused") throw new Error(`Transfer journal refused ${result.reason}`)
    return
  }
  let sequence = 0
  for (let offset = 0; offset < bytes.byteLength; offset += transferMemberChunkBytes) {
    const chunk = bytes.subarray(offset, offset + transferMemberChunkBytes)
    const final = offset + chunk.byteLength === bytes.byteLength
    const result = await transactions.acceptMember({
      transferId,
      memberId,
      sequence,
      bytes: chunk.toString("base64"),
      final,
      client: "desktop",
    })
    if (result.state === "refused") throw new Error(`Transfer journal refused ${result.reason}`)
    sequence += 1
  }
}

export async function stageOutgoingSessionTransferPackage(
  transactions: FileTransferTransactions,
  packaged: PackagedSessionTransfer,
): Promise<void> {
  const prepared = await transactions.prepare(packaged.manifest, packaged.manifestDigest)
  if (prepared.state === "refused") {
    throw new Error(`Transfer journal refused ${prepared.reason}`)
  }
  if (prepared.state === "committed") return
  const missing = prepared.state === "receiving"
    ? new Set(prepared.missingMemberIds)
    : new Set<string>()
  for (const entry of packaged.members) {
    if (missing.has(entry.member.memberId)) {
      await stageMember(
        transactions,
        packaged.manifest.transferId,
        entry.member.memberId,
        entry.bytes,
      )
    }
  }
  const status = await transactions.status(packaged.manifest.transferId, packaged.manifestDigest)
  if (status.state !== "prepared" && status.state !== "committed") {
    throw new Error("The outgoing transfer package is incomplete")
  }
}

async function sendMember(input: {
  transactions: FileTransferTransactions
  manifest: SessionTransferManifest
  manifestDigest: string
  memberId: string
  client: ClientKind
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
}): Promise<TransferMemberResult> {
  const bytes = await input.transactions.readMember(
    input.manifest.transferId,
    input.manifestDigest,
    input.memberId,
  )
  const chunks = bytes.byteLength === 0
    ? [Buffer.alloc(0)]
    : Array.from(
        { length: Math.ceil(bytes.byteLength / transferMemberChunkBytes) },
        (_, index) => bytes.subarray(
          index * transferMemberChunkBytes,
          (index + 1) * transferMemberChunkBytes,
        ),
      )
  let result: TransferMemberResult | undefined
  for (const [sequence, chunk] of chunks.entries()) {
    result = matchingTransferResult(input.manifest.transferId, transferMemberResultSchema.parse(
      await input.call("transfer.member", {
      transferId: input.manifest.transferId,
      memberId: input.memberId,
      sequence,
      bytes: chunk.toString("base64"),
      final: sequence === chunks.length - 1,
      client: input.client,
      }),
    ))
    if (result.state === "refused") return result
  }
  if (!result) throw new Error("A transfer member produced no chunks")
  return result
}

function matchingTransferResult<T extends { transferId: string }>(
  transferId: string,
  result: T,
): T {
  if (result.transferId !== transferId) throw new Error("Target transfer identity changed")
  return result
}

export async function sendPreparedSessionTransfer(input: {
  transactions: FileTransferTransactions
  transferId: string
  manifestDigest: string
  client: ClientKind
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
}): Promise<RemoteTransferResult> {
  let status: TransferStatusResult
  try {
    status = matchingTransferResult(
      input.transferId,
      transferStatusResultSchema.parse(await input.call("transfer.status", {
        transferId: input.transferId,
        manifestDigest: input.manifestDigest,
        client: input.client,
      })),
    )
  } catch {
    return transferStatusResultSchema.parse({ state: "unknown", transferId: input.transferId })
  }
  if (
    status.state === "committed"
    || status.state === "recovering"
    || status.state === "failed"
    || status.state === "aborted"
  ) return status

  const manifest = await input.transactions.manifest(input.transferId, input.manifestDigest)
  const prepared = matchingTransferResult(
    input.transferId,
    transferPrepareResultSchema.parse(await input.call("transfer.prepare", {
      manifest,
      manifestDigest: input.manifestDigest,
      client: input.client,
    })),
  )
  if (prepared.state === "committed" || prepared.state === "refused") return prepared
  if (prepared.state === "receiving") {
    const declared = new Set(manifest.members.map((member) => member.memberId))
    if (prepared.missingMemberIds.some((memberId) => !declared.has(memberId))) {
      throw new Error("The target requested an undeclared transfer member")
    }
    for (const memberId of prepared.missingMemberIds) {
      const result = await sendMember({ ...input, manifest, memberId })
      if (result.state === "refused") return result
    }
  }
  return matchingTransferResult(
    input.transferId,
    transferCommitResultSchema.parse(await input.call("transfer.commit", {
      transferId: input.transferId,
      manifestDigest: input.manifestDigest,
      client: input.client,
    })),
  )
}
