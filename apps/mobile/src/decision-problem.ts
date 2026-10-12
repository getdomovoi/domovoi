import { approvalCheckpointErrorCode, approvalCheckpointRefusalSchema, type ApprovalCheckpointRefusal } from "@getdomovoi/protocol"

import { DaemonError, DaemonNotSentError, DaemonUnconfirmedError } from "./lib/daemon"
import { DaemonTimeoutError } from "./lib/request-timeout"

// A decision that did not come back confirmed. Three answers, told apart by
// the transport's own classes, because the phone may only claim what it can
// prove. Not sent: the frame never left, so the gate is still waiting. The
// daemon refused: quoted as it states it, and the gate is still waiting.
// Unconfirmed: the frame left and no answer came, so the daemon may have
// applied the decision; the phone says it does not know, and that the screen
// shows which once the connection returns, because the snapshot then either
// carries the gate or does not. Asserting "not sent" here would be the phone
// telling a person they denied something they allowed.
export function decisionProblem(cause: unknown): string {
  if (cause instanceof DaemonNotSentError) {
    return `Not sent: ${lowerFirst(trimStop(cause.message))}. The gate is still waiting.`
  }
  if (cause instanceof DaemonError) {
    // Error data is not tied to a code on the wire, so both must say so.
    const checkpoint = cause.code === approvalCheckpointErrorCode ? approvalCheckpointRefusalSchema.safeParse(cause.data) : undefined
    if (checkpoint?.success === true) return `The daemon refused: ${checkpointLine(checkpoint.data, cause.message)} The gate is still waiting.`
    return daemonSaysStillWaiting.test(cause.message)
      ? `The daemon refused: ${cause.message.trim()}`
      : `The daemon refused: ${trimStop(cause.message)}. The gate is still waiting.`
  }
  if (cause instanceof DaemonUnconfirmedError || cause instanceof DaemonTimeoutError) {
    return "The daemon went away before it confirmed. The gate may or may not have been answered; when the connection returns, this screen shows which."
  }
  return "The decision did not come back confirmed. When the connection returns, this screen shows whether the gate is still waiting."
}

// A checkpoint the daemon could not take before an allow, from the cause it
// sent as data (S3.10h, #743), in the desktop card's words. Which setting
// refused, what Git stopped on, or what to install, is the daemon's own
// detail, so for those causes its sentence follows.
const checkpointCausesWithDetail: ReadonlySet<ApprovalCheckpointRefusal["cause"]> = new Set([
  "repository-config", "repository-config-unreadable", "git-unavailable",
])

function checkpointLine(refusal: ApprovalCheckpointRefusal, message: string): string {
  const cause = checkpointCause(refusal)
  const line = `Could not take a checkpoint${cause === undefined ? "" : `: ${cause}`}. Nothing ran.`
  if (!checkpointCausesWithDetail.has(refusal.cause)) return line
  return `${line} ${trimStop(message.trim())}.`
}

function checkpointCause(refusal: ApprovalCheckpointRefusal): string | undefined {
  switch (refusal.cause) {
    case "lock-held":
      return `${refusal.lockPath} is held by another git process, or was left by one that stopped`
    case "submodule-changes":
      return "a submodule has local changes a checkpoint cannot hold"
    case "repository-config":
      return "this repository's own Git config asks for something Domovoi does not run"
    case "repository-config-unreadable":
      return "Git could not read this repository's config"
    case "git-unavailable":
      return "this machine's Git is missing, or not a version Domovoi can use"
    case "timed-out":
      return "it did not finish in time"
    case "git-failed":
      return "a Git command failed"
    case "unknown":
      return undefined
  }
}

// The daemon states this itself as its closing sentence when a decision was
// not applied. Only that whole closing sentence counts; the words anywhere
// else in a message leave the phone's own line in place.
const daemonSaysStillWaiting = /(?:^|\.\s+)The approval is still waiting\.\s*$/

function trimStop(text: string): string {
  return text.replace(/\.$/, "")
}

function lowerFirst(text: string): string {
  return text.replace(/^The /, "the ")
}
