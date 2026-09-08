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
