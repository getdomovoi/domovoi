import type { ProviderModel, SessionAttachment } from "@getdomovoi/protocol"

import { isImageAttachment } from "./desktop-attachments"

// Sending while a turn is running queues the message. It never cancels the
// turn: the agent is mid-flight on a worktree, and a client keystroke is not a
// reason to abandon work that may be half-written. Stopping is its own control.
export type QueueOutcome =
  | { action: "send"; text: string }
  | { action: "queue"; text: string; note: string }
  | { action: "ignore" }

export function submitFromComposer({
  text,
  turnRunning,
  queued,
}: {
  text: string
  turnRunning: boolean
  queued: string | undefined
}): QueueOutcome {
  const trimmed = text.trim()
  if (!trimmed) return { action: "ignore" }
  if (!turnRunning) return { action: "send", text: trimmed }
  // One queued message, replaced rather than stacked: a queue of three is a
  // conversation the person cannot see the agent answering.
  return {
    action: "queue",
    text: trimmed,
    note: queued ? "replaces the queued message" : "sends at the next turn boundary",
  }
}

// A queued message is either waiting for the turn boundary or held for a
// person. Nothing moves it from held back to waiting except an explicit act:
// a refused send that re-queued itself would retry on the next render, and a
// stop that released the queue would restart the work it was meant to end.
export type QueuedMessage = {
  sessionId: string
  text: string
  state: "waiting" | "held"
  reason?: string
  // The skills chosen when it was queued. Kept so the release resolves the
  // same choice the person made, and refuses if one has since gone.
  skillIds?: readonly string[]
  attachments?: readonly SessionAttachment[]
}

// One slot per session, not one slot. Queueing in B must not overwrite what is
// waiting in A: the person queued two messages for two agents, and silently
// dropping one is worse than refusing it.
export type SessionQueues = Readonly<Record<string, QueuedMessage>>

export function setQueue(
  queues: SessionQueues,
  sessionId: string,
  next: QueuedMessage | undefined,
): SessionQueues {
  const { [sessionId]: previous, ...rest } = queues
  void previous
  return next ? { ...rest, [sessionId]: next } : rest
}

// A stop ends every running turn, so it holds every queue, not just the one on
// screen. Any client's stop counts: the work stops on the machine either way.
export function holdAllAfterStop(queues: SessionQueues): SessionQueues {
  const held: Record<string, QueuedMessage> = {}
  for (const [sessionId, queued] of Object.entries(queues)) {
    held[sessionId] = heldAfterStop(queued) ?? queued
  }
  return held
}

export function shouldRelease({
  queued,
  sessionId,
  turnRunning,
  busy,
}: {
  queued: QueuedMessage | undefined
  sessionId: string
  turnRunning: boolean
  busy: boolean
}): boolean {
  if (!queued || queued.sessionId !== sessionId) return false
  if (queued.state !== "waiting") return false
  return !turnRunning && !busy
}

// A waiting message on a session with no turn running is the next thing to
// go. The release may still be waiting, on the skill catalog, on its own
// catalog read for images, or on an earlier send to settle. A message sent
// past it reaches the daemon first, and the daemon does not refuse a send
// while a turn runs, so the order the person wrote them in would invert.
// Queueing the new one would replace the waiting one, so the new one stays a
// draft until the waiting one has left. Held is not waiting: nothing releases
// it but the person, so it never holds a new message back.
export function awaitingRelease(
  queued: QueuedMessage | undefined,
  sessionId: string,
  turnRunning: boolean,
): boolean {
  return queued?.sessionId === sessionId && queued.state === "waiting" && !turnRunning
}

export function heldAfter(queued: QueuedMessage, reason: string): QueuedMessage {
  return { ...queued, state: "held", reason }
}

// A stop ends the turn. Treating that ending as the ordinary boundary would
// send the queued message into the silence the stop just made.
export function heldAfterStop(queued: QueuedMessage | undefined): QueuedMessage | undefined {
  if (!queued || queued.state === "held") return queued
  return heldAfter(queued, "Held because work was stopped. Send it when you want it to run.")
}

// Which queues may go right now. Sessions, not the session on screen: a turn
// ending in A releases A's message whether or not anyone is looking at A.
export function releasableQueues(
  sessions: readonly { id: string, activeTurnId?: string | undefined }[],
  queues: SessionQueues,
  { busy }: { busy: boolean },
): QueuedMessage[] {
  const ready: QueuedMessage[] = []
  for (const session of sessions) {
    const queued = queues[session.id]
    if (!shouldRelease({
      queued,
      sessionId: session.id,
      turnRunning: Boolean(session.activeTurnId),
      busy,
    })) continue
    ready.push(queued!)
  }
  return ready
}

// Images only: a model that takes no image input still takes text files.
export function carriesImages(queued: QueuedMessage): boolean {
  return Boolean(queued.attachments?.some(isImageAttachment))
}

// For each provider and model, the newest catalog read (by the ticket taken
// when it started) whose answer said the model takes no image input.
export type ImageRefusals = Readonly<Record<string, number>>

function refusalKey(provider: string, model: string): string {
  return `${provider}\n${model}`
}

export function noteImageRefusals(current: ImageRefusals, models: readonly ProviderModel[], ticket: number): ImageRefusals {
  let next: Record<string, number> | undefined
  for (const model of models) {
    if (model.imageInput !== false) continue
    const key = refusalKey(model.provider, model.id)
    if ((current[key] ?? 0) >= ticket) continue
    next ??= { ...current }
    next[key] = ticket
  }
  return next ?? current
}

// The release's own catalog read for one message, started when the message
// became releasable at the turn boundary.
export type ReleaseRead = { since: number, settled: boolean }

// Whether a releasable message may go to the session's model. The daemon
// refuses images for a model whose harness reports no image input, so that
// message is held rather than sent into a refusal. The daemon asks the
// adapter on every catalog read and the answer can change while a turn runs,
// so only reads started at or after the boundary count: a no from any of them
// holds at once, and otherwise the message waits for the release's own read.
// Waiting is not holding: the message stays waiting. Nothing holds on what is
// not known, a failed read or a model that has not said, which is #846's rule
// in the composer.
export function imageRelease(
  queued: QueuedMessage,
  runtime: { provider: string, model: string },
  refusals: ImageRefusals,
  read: ReleaseRead,
): "release" | "wait" | "hold" {
  if (!carriesImages(queued)) return "release"
  if ((refusals[refusalKey(runtime.provider, runtime.model)] ?? 0) > read.since) return "hold"
  return read.settled ? "release" : "wait"
}

// A send that did not come back with a result. The distinction matters: the
// daemon answering with an error means nothing ran, while a socket that
// dropped before answering means Domovoi does not know what ran.
export type FailedAttempt = {
  id: string
  sessionId: string
  text: string
  delivery: "refused" | "unconfirmed"
  // Whether the daemon answered at all. An error answer and a dropped socket
  // are both unconfirmed, but they are not the same thing to read.
  answered: boolean
  reason: string
  skillIds?: readonly string[]
  // Kept so queueing it again sends what the person attached; a refusal
  // must not drop their files or images.
  attachments?: readonly SessionAttachment[]
}

// Only an error the daemon raises before it starts work proves the turn never
// ran. An internal error can arrive after startTurn succeeded, so the default
// is unconfirmed: claiming nothing ran and being wrong makes a person run it
// twice, while claiming it might have run and being wrong only makes them look.
const refusalCodes: readonly number[] = [
  -32001, // authentication refused at the door
  -32011, // machine credential missing
  -32012, // protocol version mismatch
  -32013, // device pairing limit
  -32015, // turn skill selection refused
  -32602, // invalid params, rejected before any work
]

export function provesNothingRan(code: number | undefined): boolean {
  return code !== undefined && refusalCodes.includes(code)
}

export function failedAttempt(
  id: string,
  message: QueuedMessage,
  { refused, answered, reason }: { refused: boolean, answered: boolean, reason: string },
): FailedAttempt {
  return {
    id,
    sessionId: message.sessionId,
    text: message.text,
    delivery: refused ? "refused" : "unconfirmed",
    answered,
    reason,
    ...(message.skillIds ? { skillIds: message.skillIds } : {}),
    ...(message.attachments ? { attachments: message.attachments } : {}),
  }
}

// What the row says. "Not sent" is only true when the daemon refused it; a
// lost answer must not claim the work did not happen.
export function deliveryLabel(attempt: FailedAttempt): string {
  if (attempt.delivery === "refused") return `not sent: ${attempt.reason}`
  // An error answer did arrive here, so saying Domovoi never heard back would
  // be wrong in the other direction. What is unknown is whether work started.
  return attempt.answered
    ? `delivery could not be confirmed, an error answer arrived: ${attempt.reason}`
    : `Domovoi never got an answer, so this may have run: ${attempt.reason}`
}
