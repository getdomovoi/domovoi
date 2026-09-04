import type { SessionTransferResult } from "@getdomovoi/protocol"

type Incomplete = Extract<SessionTransferResult, { outcome: "incomplete" }>
type FailureReason = Extract<Incomplete, { state: "failed" }>["reason"]
type RecoveryStage = Extract<Incomplete, { state: "recovering" }>["stage"]

// A move that did not finish is not one story. The daemon says which stage it
// reached and what would answer it, and collapsing that into one sentence left
// the operator guessing whether to wait, retry, or go and recover the source.
const failureDetail: Record<FailureReason, string> = {
  "repository-restore-failed": "The repository could not be restored there.",
  "state-import-failed": "The session state could not be imported there.",
  "resource-import-failed": "The artifacts and attachments could not be imported there.",
  "persistence-failed": "The target could not save the session it received.",
  "recovery-failed": "The target could not undo the partial move.",
}

const recoveringDetail: Record<RecoveryStage, string> = {
  repository: "The target is undoing the repository it restored.",
  state: "The target is undoing the session state it imported.",
  resources: "The target is undoing the artifacts it imported.",
  persistence: "The target is undoing what it saved.",
}

export type TransferOutcomeNotice = {
  title: string
  detail: string
  // The action the operator takes next, when there is one they can take.
  action: Exclude<Incomplete["recoveryAction"], "none"> | undefined
}

// A machine the session came from still holds the read-only copy it kept, and
// the daemon refuses any target that already knows the session id. The refusal
// is accurate but reads as corruption, so the origin is named instead.
export function returnTransferExplanation(
  originMachineId: string | undefined,
  targetMachineId: string,
  targetLabel: string,
): string | undefined {
  if (originMachineId === undefined || originMachineId !== targetMachineId) return undefined
  return `This session came from ${targetLabel}, which kept a read-only copy of it. Moving a session back to a machine it came from is not supported yet.`
}

export function transferOutcomeNotice(
  result: Incomplete,
  sourceLabel: string,
): TransferOutcomeNotice {
  const stayed = `The session stayed on ${sourceLabel}.`
  switch (result.state) {
    case "unknown":
      return {
        title: "The move did not report back",
        detail: `${stayed} Check the transfer to see whether it landed.`,
        action: "check-status",
      }
    case "receiving":
      return {
        title: "The move stopped partway",
        detail: `${stayed} The target still has what it received, so this can carry on.`,
        action: "resume",
      }
    case "prepared":
      return {
        title: "The move stopped before it was committed",
        detail: `${stayed} The target has everything and is waiting to commit it.`,
        action: "resume",
      }
    case "recovering":
      return {
        title: "The target is undoing the move",
        detail: `${stayed} ${recoveringDetail[result.stage]}`,
        action: undefined,
      }
    case "failed":
      return {
        title: "The move failed",
        detail: `${stayed} ${failureDetail[result.reason]}`,
        action: "retry",
      }
    case "ownership-unconfirmed":
      return {
        title: "The move did not confirm ownership",
        detail: `${stayed} Confirm the target does not have it before working here again.`,
        action: "confirm-source-recovery",
      }
    case "ownership-conflict":
      return {
        title: "Both machines claim the session",
        // The only safe way out is one-way: this machine gives up the claim and
        // keeps its worktree to read. Saying that here means the person meets
        // the trade before the confirmation rather than after it.
        detail: `${stayed} Settling it hands the session to the other machine and leaves a read-only copy here.`,
        action: "keep-target-session",
      }
  }
}
