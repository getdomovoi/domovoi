import { createHash } from "node:crypto"

import {
  sourcePreflight,
  transferPreflight,
  transferChunkResultSchema,
  transferBeginResultSchema,
  type ClientKind,
  type FleetMachine,
  type SessionSummary,
  type TransferReceipt,
} from "@getdomovoi/protocol"

import type { Checkpoint, SessionBundle } from "./workspace.js"

// Chunks are small enough that a stalled transfer wastes little, and large
// enough that a worktree does not arrive one packet at a time.
export const maximumTransferChunkBytes = 262_144

export type TransferOutcome =
  | { outcome: "succeeded"; workspacePath: string; checkpointCommit: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed" }

export async function sendSessionToMachine(input: {
  session: SessionSummary
  sourceMachineId: string
  target: FleetMachine
  client: ClientKind
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
  checkpoint: (worktreePath: string, label: string) => Promise<Checkpoint>
  bundleSession: (worktreePath: string, bundlePath: string) => Promise<SessionBundle>
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
    const bundle = await input.bundleSession(worktreePath, `${worktreePath}.bundle`)
    const bytes = await input.readBundle(bundle.path)
    const digest = createHash("sha256").update(bytes).digest("hex")

    const begun = transferBeginResultSchema.parse(await input.call("transfer.begin", {
      sessionId: input.session.id,
      sourceMachineId: input.sourceMachineId,
      method: "git-bundle",
      digest,
      totalBytes: bytes.length,
      client: input.client,
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
