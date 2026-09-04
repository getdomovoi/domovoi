import type { SessionSummary } from "@getdomovoi/protocol"

export type SessionRecoveryOffer = {
  transferId: string
  targetMachineId: string
  title: string
  detail: string
  // The daemon requires the operator to state this, so the dialog asks for it
  // in words before it is sent rather than sending it on their behalf.
  confirmation: "target-does-not-have-session"
  confirmLabel: string
}

// A move that stopped leaves the source frozen and waiting. The daemon can only
// release it on an operator's word that the target did not take the session,
// which is a claim no client may make for them, so the offer exists to put that
// claim in front of the person rather than to make the decision.
export function sessionRecoveryOffer(
  session: SessionSummary,
  targetLabel: string | undefined,
): SessionRecoveryOffer | undefined {
  const transfer = session.transfer
  if (session.state !== "transferring") return undefined
  if (transfer?.phase !== "transferring") return undefined
  // Only a move the daemon has given up on. One still running would be raced by
  // a recovery, and one that has not started may still succeed on its own.
  if (transfer.resumeState !== "failed") return undefined

  const target = targetLabel ?? "the other machine"
  return {
    transferId: transfer.transferId,
    targetMachineId: transfer.targetMachineId,
    title: "This session is frozen after a move that did not finish",
    detail: `It cannot be worked on here until it is released. Release it only if ${target} did not take the session, because two machines writing the same work will diverge.`,
    confirmation: "target-does-not-have-session",
    confirmLabel: `${target} does not have it`,
  }
}
