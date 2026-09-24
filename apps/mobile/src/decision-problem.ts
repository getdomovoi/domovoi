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
    return daemonSaysStillWaiting.test(cause.message)
      ? `The daemon refused: ${cause.message.trim()}`
      : `The daemon refused: ${trimStop(cause.message)}. The gate is still waiting.`
  }
  if (cause instanceof DaemonUnconfirmedError || cause instanceof DaemonTimeoutError) {
    return "The daemon went away before it confirmed. The gate may or may not have been answered; when the connection returns, this screen shows which."
  }
  return "The decision did not come back confirmed. When the connection returns, this screen shows whether the gate is still waiting."
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
