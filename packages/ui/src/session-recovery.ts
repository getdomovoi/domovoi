import type { SessionSummary, SessionTransferReconciliationReason } from "@getdomovoi/protocol"

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

const reconciliationCause: Record<SessionTransferReconciliationReason, string> = {
  "target-unreachable": "cannot be reached",
  "target-timeout": "is not answering",
  "target-pairing-required": "needs pairing again",
}

// How long the silence has lasted decides whether a person believes the target
// is gone, so it is said in the units they think in rather than as a timestamp.
export function silenceFor(sinceIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(sinceIso)) / 60_000))
  if (minutes < 1) return "less than a minute"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"}`
}

// The daemon keeps retrying a stalled move on its own, so the dangerous claim
// appears only once it has tried and failed to reach the target and says so.
// The RPC checks the target again on the click, so a machine that came back in
// the meantime refuses or completes rather than being declared empty.
export function sessionRecoveryOffer(
  session: SessionSummary,
  targetLabel: string | undefined,
  now: Date = new Date(),
): SessionRecoveryOffer | undefined {
  const transfer = session.transfer
  if (session.state !== "transferring") return undefined
  if (transfer?.phase !== "transferring") return undefined
  if (transfer.package.state !== "staged") return undefined
  const failure = transfer.package.reconciliation
  if (failure?.state !== "ownership-unconfirmed") return undefined

  const target = targetLabel ?? "the other machine"
  const silence = silenceFor(failure.firstFailedAt, now)
  return {
    kind: "release-stranded",
    transferId: transfer.transferId,
    targetMachineId: transfer.targetMachineId,
    title: "This session is frozen after a move that did not finish",
    detail: `${target} ${reconciliationCause[failure.reason]}, and Domovoi has been trying for ${silence} across ${failure.attemptCount} attempt${failure.attemptCount === 1 ? "" : "s"}. Release this session only if ${target} did not take it, because two machines writing the same work will diverge.`,
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
  // The two kinds end the same way, because the returning machine holds the
  // only ownership generation anyone can verify, but they do not read the same.
  // One found a copy it never owned; the other did work here after recovering
  // the session, and the copy it keeps is that work.
  const detail = conflict.kind === "target-session-detected"
    ? `${other} already holds a copy of this session. Settling this hands the session to ${other} for good. The files here stay on disk and readable, but they stop being the session, and nothing removes them for you.`
    : `${other} came back holding this session after it was recovered here. It holds the only ownership this machine can check, so settling this hands the session to ${other} for good. The work done here since the recovery stays on disk and readable, to copy across by hand, and nothing removes it for you.`
  return {
    kind: "keep-target",
    transferId: conflict.transferId,
    targetMachineId: conflict.otherMachineId,
    title: `${other} also claims this session`,
    detail,
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
