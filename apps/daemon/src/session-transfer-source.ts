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
): WorkspaceSnapshot {
  const session = sourceSession(snapshot, intent.state.session.id)
  if (
    intent.preview.sourceMachineId !== snapshot.machine.id
    || intent.preview.targetMachineId === snapshot.machine.id
    || intent.preview.project.sourceProjectId !== snapshot.project?.id
    || session.state === "transferring"
    || session.state === "transferred"
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
  sourceSession(candidate, manifest.sessionId).baseCommit = manifest.project.checkpointCommit
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
    completedAt,
  }
  delete completed.providerThreadId
  delete completed.providerFailure
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
    result = transferMemberResultSchema.parse(await input.call("transfer.member", {
      transferId: input.manifest.transferId,
      memberId: input.memberId,
      sequence,
      bytes: chunk.toString("base64"),
      final: sequence === chunks.length - 1,
      client: input.client,
    }))
    if (result.state === "refused") return result
  }
  if (!result) throw new Error("A transfer member produced no chunks")
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
    status = transferStatusResultSchema.parse(await input.call("transfer.status", {
      transferId: input.transferId,
      manifestDigest: input.manifestDigest,
      client: input.client,
    }))
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
  const prepared = transferPrepareResultSchema.parse(await input.call("transfer.prepare", {
    manifest,
    manifestDigest: input.manifestDigest,
    client: input.client,
  }))
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
  return transferCommitResultSchema.parse(await input.call("transfer.commit", {
    transferId: input.transferId,
    manifestDigest: input.manifestDigest,
    client: input.client,
  }))
}
