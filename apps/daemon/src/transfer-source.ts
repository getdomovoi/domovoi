import { createHash } from "node:crypto"

import {
  sourcePreflight,
  transferPreflight,
  transferChunkResultSchema,
  transferFromRefResultSchema,
  transferHaveResultSchema,
  transferBeginResultSchema,
  type ClientKind,
  type FleetMachine,
  type SessionSummary,
  type TransferReceipt,
} from "@getdomovoi/protocol"

import type { Checkpoint, SessionBundle, SessionRef } from "./workspace.js"

// Chunks are small enough that a stalled transfer wastes little, and large
// enough that a worktree does not arrive one packet at a time.
export const maximumTransferChunkBytes = 262_144

export type TransferOutcome =
  | { outcome: "succeeded"; workspacePath: string; checkpointCommit: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed" }

// The opt-in path. The bytes travel through the remote both machines already
// share, so this daemon pushes a session ref and asks the target to take it.
export async function sendSessionThroughRemote(input: {
  session: SessionSummary
  sourceMachineId: string
  target: FleetMachine
  client: ClientKind
  remote: string
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
  checkpoint: (worktreePath: string, label: string) => Promise<Checkpoint>
  pushSessionRef: ((
    worktreePath: string,
    remote: string,
    sessionId: string,
  ) => Promise<SessionRef>) | undefined
  recordReceipt: (receipt: TransferReceipt) => void
  now: () => string
}): Promise<TransferOutcome> {
  const startedAt = input.now()
  const unknownCommit = "0".repeat(40)
  const receipt = (
    outcome: TransferReceipt["outcome"],
    checkpointCommit: string,
    reason?: TransferReceipt["reason"],
  ): void => {
    input.recordReceipt({
      sessionId: input.session.id,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.target.id,
      method: "remote-ref",
      checkpointId: `checkpoint-${checkpointCommit}`,
      checkpointCommit,
      recoveryCheckpointRetained: true,
      outcome,
      ...(reason ? { reason } : {}),
      decidedBy: { client: input.client },
      startedAt,
      completedAt: input.now(),
    })
  }

  const source = sourcePreflight({ session: input.session })
  if (!source.allowed) {
    receipt("refused", unknownCommit, source.reason)
    return { outcome: "refused", reason: source.reason }
  }
  const reachable = transferPreflight({
    source: { ...input.target, id: input.sourceMachineId },
    target: input.target,
  })
  if (!reachable.allowed) {
    receipt("refused", unknownCommit, reachable.reason)
    return { outcome: "refused", reason: reachable.reason }
  }
  if (!input.pushSessionRef) {
    receipt("failed", unknownCommit)
    return { outcome: "failed" }
  }

  let checkpointCommit = unknownCommit
  try {
    const checkpoint = await input.checkpoint(input.session.workspacePath!, "before-transfer")
    checkpointCommit = checkpoint.commit
    await input.pushSessionRef(input.session.workspacePath!, input.remote, input.session.id)
    const taken = transferFromRefResultSchema.parse(await input.call("transfer.fromRef", {
      sessionId: input.session.id,
      remote: input.remote,
      client: input.client,
    }))
    receipt("succeeded", checkpointCommit)
    return {
      outcome: "succeeded",
      workspacePath: taken.workspacePath,
      checkpointCommit: taken.checkpointCommit,
    }
  } catch {
    // The session is still here: nothing on this machine is removed because a
    // remote or a target did not cooperate.
    receipt("failed", checkpointCommit)
    return { outcome: "failed" }
  }
}

export async function sendSessionToMachine(input: {
  session: SessionSummary
  sourceMachineId: string
  target: FleetMachine
  client: ClientKind
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
  checkpoint: (worktreePath: string, label: string) => Promise<Checkpoint>
  bundleSession: (
    worktreePath: string,
    bundlePath: string,
    sinceCommit?: string,
  ) => Promise<SessionBundle>
  readBundle: (bundlePath: string) => Promise<Buffer>
  recordReceipt: (receipt: TransferReceipt) => void
  now: () => string
}): Promise<TransferOutcome> {
  const startedAt = input.now()
  const receipt = (
    outcome: TransferReceipt["outcome"],
    checkpointCommit: string,
    reason?: TransferReceipt["reason"],
  ): void => {
    input.recordReceipt({
      sessionId: input.session.id,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.target.id,
      method: "git-bundle",
      checkpointId: `checkpoint-${checkpointCommit}`,
      checkpointCommit,
      // The source keeps its recovery checkpoint whatever happens, so the
      // session can always be picked up again here.
      recoveryCheckpointRetained: true,
      outcome,
      ...(reason ? { reason } : {}),
      decidedBy: { client: input.client },
      startedAt,
      completedAt: input.now(),
    })
  }

  const unknownCommit = "0".repeat(40)
  const source = sourcePreflight({ session: input.session })
  if (!source.allowed) {
    receipt("refused", unknownCommit, source.reason)
    return { outcome: "refused", reason: source.reason }
  }
  const reachable = transferPreflight({
    source: { ...input.target, id: input.sourceMachineId },
    target: input.target,
  })
  if (!reachable.allowed) {
    // Nothing is bundled or sent to a machine that cannot take the session now,
    // because Domovoi never queues a move for later.
    receipt("refused", unknownCommit, reachable.reason)
    return { outcome: "refused", reason: reachable.reason }
  }

  const worktreePath = input.session.workspacePath!
  let checkpointCommit = unknownCommit
  try {
    const checkpoint = await input.checkpoint(worktreePath, "before-transfer")
    checkpointCommit = checkpoint.commit
    // Asking first is what makes the move incremental: the target names a
    // commit it already holds, and only what is missing travels.
    const held = transferHaveResultSchema.parse(await input.call("transfer.have", {
      sessionId: input.session.id,
      client: input.client,
    }))
    const bundle = await input.bundleSession(
      worktreePath,
      `${worktreePath}.bundle`,
      held.commit,
    )
    const bytes = await input.readBundle(bundle.path)
    const digest = createHash("sha256").update(bytes).digest("hex")

    const begun = transferBeginResultSchema.parse(await input.call("transfer.begin", {
      sessionId: input.session.id,
      sourceMachineId: input.sourceMachineId,
      method: "git-bundle",
      digest,
      totalBytes: bytes.length,
      client: input.client,
      ...(held.commit ? { sinceCommit: held.commit } : {}),
    }))

    let sequence = 0
    for (let offset = 0; offset < bytes.length; offset += maximumTransferChunkBytes) {
      const slice = bytes.subarray(offset, offset + maximumTransferChunkBytes)
      const final = offset + maximumTransferChunkBytes >= bytes.length
      const answer = transferChunkResultSchema.parse(await input.call("transfer.chunk", {
        transferId: begun.transferId,
        sequence,
        bytes: slice.toString("base64"),
        final,
        client: input.client,
      }))
      sequence += 1
      if (answer.state === "refused") {
        // The target looked at the bytes and would not take them, which is a
        // refusal with a reason rather than a transfer that broke.
        receipt("refused", checkpointCommit, answer.reason)
        return { outcome: "refused", reason: answer.reason }
      }
      if (answer.state === "restored") {
        // A session cannot have arrived while bytes remain here, whatever the
        // target says, so an early claim ends the transfer as a failure.
        if (!final) {
          receipt("failed", checkpointCommit)
          return { outcome: "failed" }
        }
        receipt("succeeded", checkpointCommit)
        return {
          outcome: "succeeded",
          workspacePath: answer.workspacePath,
          checkpointCommit: answer.checkpointCommit,
        }
      }
    }

    receipt("failed", checkpointCommit)
    return { outcome: "failed" }
  } catch {
    // Whatever went wrong, this machine still holds the session: nothing here
    // is removed until a target says it has the worktree.
    receipt("failed", checkpointCommit)
    return { outcome: "failed" }
  }
}
