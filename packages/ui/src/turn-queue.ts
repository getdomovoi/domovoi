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

export function heldAfter(queued: QueuedMessage, reason: string): QueuedMessage {
  return { ...queued, state: "held", reason }
}

// A stop ends the turn. Treating that ending as the ordinary boundary would
// send the queued message into the silence the stop just made.
export function heldAfterStop(queued: QueuedMessage | undefined): QueuedMessage | undefined {
  if (!queued || queued.state === "held") return queued
  return heldAfter(queued, "Held because work was stopped. Send it when you want it to run.")
}
