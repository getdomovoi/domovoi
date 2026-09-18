import { DaemonError } from "./lib/daemon"
import { DaemonTimeoutError } from "./lib/request-timeout"

// A decision that did not reach the daemon. The gate is still waiting on the
// machine, and a client that could not answer it has not changed it, so every
// sentence here ends by saying so. The daemon's own refusal is quoted as it
// states it; a transport failure is named as one, not as a refusal.
export function decisionProblem(cause: unknown): string {
  const stillWaiting = "The gate is still waiting."
  if (cause instanceof DaemonError) return `The daemon refused: ${cause.message.replace(/\.$/, "")}. ${stillWaiting}`
  if (cause instanceof DaemonTimeoutError) return `Not sent: the daemon did not answer in time. ${stillWaiting}`
  if (cause instanceof Error) return `Not sent: ${cause.message.replace(/\.$/, "").replace(/^The /, "the ")}. ${stillWaiting}`
  return `Not sent. ${stillWaiting}`
}
