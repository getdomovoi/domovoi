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
  // Unique across every workspace this client holds, so an alert can name
  // the one read it reports (alertDrawnInThread).
  id: number
  startedAt: Date
  endedAt: Date
  outcome: SessionReadOutcome
}

let lastSessionReadId = 0

export function nextSessionReadId(): number {
  lastSessionReadId += 1
  return lastSessionReadId
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

// Thrown by useWorkspace's activateSession once it has recorded a failed
// read, naming the attempt it recorded.
export class SessionReadError extends Error {
  readonly outcome: SessionReadOutcome
  readonly readId: number

  constructor(outcome: SessionReadOutcome, cause: unknown, readId: number) {
    super(cause instanceof Error ? cause.message : "The session could not be read", { cause })
    this.name = "SessionReadError"
    this.outcome = outcome
    this.readId = readId
  }
}

// What an activation failure puts in the shell's alert, and the failed read
// it reports when it reports one.
export type ActivationAlert = { message: string, readId: number | undefined }

export function activationAlert(cause: unknown, fallback: string): ActivationAlert {
  return {
    message: cause instanceof Error ? cause.message : fallback,
    readId: cause instanceof SessionReadError ? cause.readId : undefined,
  }
}

// Whether the alert would only repeat what the thread column draws: the
// column draws the very read the alert reports, as its latest attempt, and
// the alert still says that read's message. Decided from what renders rather
// than predicted when the read failed, so any read the column does not draw
// (another machine's, a session already open, one the list lacks, a view
// without the thread) keeps the alert.
export function alertDrawnInThread(alert: ActivationAlert | null, message: string, drawn: SessionReadFailure | null): boolean {
  return alert !== null
    && alert.readId !== undefined
    && alert.message === message
    && drawn?.recent.at(-1)?.id === alert.readId
}
