import { DaemonRpcError, DomovoiRpcTimeoutError } from "./client"

// How a session read (session.activate, whose answer is the workspace with
// that session's thread) ended without an answer this client could draw. A
// daemon that answered and refused is not here: that is an answer, and the
// shell's alert says it.
export type SessionReadOutcome =
  | { kind: "timeout", timeoutMs: number }
  | { kind: "closed" }
  | { kind: "unreadable" }

export type SessionReadAttempt = {
  startedAt: Date
  endedAt: Date
  outcome: SessionReadOutcome
}

// The reads this client sent for one session, in a row, that ended without
// an answer. `count` is every one of them; `recent` keeps the last few for
// the log, so a long run of retries does not grow the log without end.
export type SessionReadFailure = {
  sessionId: string
  count: number
  recent: readonly SessionReadAttempt[]
  // A Try again for this session is in flight.
  retrying: boolean
}

export const sessionReadLogAttempts = 5

// The client's own words for a request that ended without an answer
// (client.ts): the socket closed under it, or the daemon's answer did not
// parse as the workspace the method returns. Everything else, a refusal
// included, is not a failed read.
export function sessionReadOutcome(cause: unknown): SessionReadOutcome | undefined {
  if (cause instanceof DomovoiRpcTimeoutError) return { kind: "timeout", timeoutMs: cause.timeoutMs }
  if (!(cause instanceof Error) || cause instanceof DaemonRpcError) return undefined
  if (cause.message === "Daemon connection closed") return { kind: "closed" }
  if (cause.message === "Daemon returned an invalid RPC result") return { kind: "unreadable" }
  return undefined
}

// Thrown by useWorkspace's activateSession once it has recorded a failed
// read, so a caller knows the thread column already says it.
export class SessionReadError extends Error {
  readonly outcome: SessionReadOutcome

  constructor(outcome: SessionReadOutcome, cause: unknown) {
    super(cause instanceof Error ? cause.message : "The session could not be read", { cause })
    this.name = "SessionReadError"
    this.outcome = outcome
  }
}

// What an activation failure puts in the shell's alert: nothing for a failed
// read, which the thread column draws, and the message for anything else.
export function activationAlert(cause: unknown, fallback: string): string {
  if (cause instanceof SessionReadError) return ""
  return cause instanceof Error ? cause.message : fallback
}
