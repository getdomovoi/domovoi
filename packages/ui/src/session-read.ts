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
// (client.ts): the socket closed under it, the daemon's reply named the
// request but was not a response this client can parse, or its result did not
// parse as the workspace the method returns. Everything else, a refusal
// included, is not a failed read.
const unreadableAnswers = new Set([
  "Daemon returned a response this client could not parse",
  "Daemon returned an invalid RPC result",
])

export function sessionReadOutcome(cause: unknown): SessionReadOutcome | undefined {
  if (cause instanceof DomovoiRpcTimeoutError) return { kind: "timeout", timeoutMs: cause.timeoutMs }
  if (!(cause instanceof Error) || cause instanceof DaemonRpcError) return undefined
  if (cause.message === "Daemon connection closed") return { kind: "closed" }
  if (unreadableAnswers.has(cause.message)) return { kind: "unreadable" }
  return undefined
}
