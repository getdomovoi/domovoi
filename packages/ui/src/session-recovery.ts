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

// A stranded move has no offer yet, on purpose. transferRecoverSource is a
// dangerous escape hatch: it releases the source on the operator's word that the
// target did not take the session. Nothing in the snapshot says the daemon has
// stopped trying, and it retries on its own, so any signal available here would
// offer the hatch during a healthy move. It returns when the daemon records that
// operator recovery is appropriate.
export function sessionRecoveryOffer(
  _session: SessionSummary,
  _targetLabel: string | undefined,
): SessionRecoveryOffer | undefined {
  return undefined
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

// Every read-only state shared one notice, written for archiving, so a session
// that had moved to another machine told the person cleanup would resume after
// a restart. Each state says its own thing now.
export function readOnlySessionNotice(
  session: SessionSummary,
  otherLabel: string | undefined,
): { badge: string, title: string, detail: string } | undefined {
  const other = otherLabel ?? "another machine"
  switch (session.state) {
    case "archiving":
      return {
        badge: "Archiving",
        title: "Archiving session",
        detail: "Cleanup will resume safely if the daemon restarts.",
      }
    case "archived":
      return {
        badge: "Archived",
        title: "Archived",
        detail: "This session is read-only. Its history, checkpoints, artifacts, and annotations remain available.",
      }
    case "transferring":
      return {
        badge: "Moving",
        title: `Moving to ${other}`,
        detail: "This session is frozen while it moves, so nothing here can change it. Domovoi keeps reconciling it if the move is interrupted.",
      }
    case "transferred":
      return session.transfer?.phase === "transferred"
        && session.transfer.completion === "conflict-released"
        ? {
          badge: "Released",
          title: `Released to ${other}`,
          detail: `This machine gave up its claim, so ${other} holds the session now. The files here stay readable and are yours to remove.`,
        }
        : {
          badge: "Moved",
          title: `Moved to ${other}`,
          detail: `${other} holds this session now. What is here is a recovery point, kept as it was when it left.`,
        }
    case "ownership-conflict":
      return {
        badge: "Conflict",
        title: `${other} also claims this session`,
        detail: "Two machines hold this session and only one can keep it. Settle it before working on either copy.",
      }
    default:
      return undefined
  }
}
