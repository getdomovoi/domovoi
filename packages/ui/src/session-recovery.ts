import type { SessionSummary } from "@getdomovoi/protocol"

type OfferCommon = {
  transferId: string
  targetMachineId: string
  title: string
  detail: string
  confirmLabel: string
}

export type SessionRecoveryOffer =
  // The daemon requires the operator to state each of these, so the surface
  // asks for it in words before it is sent rather than sending it on their
  // behalf. The two are not interchangeable: one says the move did not happen,
  // the other accepts that it did and gives up this machine's claim.
  | (OfferCommon & { kind: "release-stranded", confirmation: "target-does-not-have-session" })
  | (OfferCommon & { kind: "keep-target", confirmation: "keep-target-session" })

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
    kind: "release-stranded",
    transferId: transfer.transferId,
    targetMachineId: transfer.targetMachineId,
    title: "This session is frozen after a move that did not finish",
    detail: `It cannot be worked on here until it is released. Release it only if ${target} did not take the session, because two machines writing the same work will diverge.`,
    confirmation: "target-does-not-have-session",
    confirmLabel: `${target} does not have it`,
  }
}

// Both machines hold a copy and only one may keep the session. The exit is one
// way on purpose: this machine can give up its claim, but it cannot take the
// session back, because a local click is not the other machine's consent.
export function sessionConflictOffer(
  session: SessionSummary,
  otherLabel: string | undefined,
): SessionRecoveryOffer | undefined {
  const conflict = session.ownershipConflict
  if (session.state !== "ownership-conflict" || conflict === undefined) return undefined

  const other = otherLabel ?? "the other machine"
  const cause = conflict.kind === "target-session-detected"
    ? `${other} already holds a copy of this session`
    : `${other} was found to hold this session after it was recovered here`
  return {
    kind: "keep-target",
    transferId: conflict.transferId,
    targetMachineId: conflict.otherMachineId,
    title: `${other} also claims this session`,
    detail: `${cause}. Settling this hands the session to ${other} for good. The files here stay on disk and readable, but they stop being the session, and nothing removes them for you.`,
    confirmation: "keep-target-session",
    confirmLabel: `${other} keeps the session`,
  }
}
