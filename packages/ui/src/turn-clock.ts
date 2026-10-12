import type { SnapshotTurn } from "@getdomovoi/protocol"

// The conversation header's clock and the activity row's "Worked for N", read
// from the snapshot's turns (ruling Q401). Both clocks the daemon wrote
// (startedAt, completedAt) are on the daemon's clock, so a duration between
// them is exact. A running turn is measured against this client's clock, so
// it can be off by the skew between the two machines; it is held at zero
// rather than drawn negative.
//
// Three states are easy to collapse and must not be: a turn that ended with
// an end the daemon saw, one that ended with no end anyone saw (a daemon
// restart), and one this client can no longer see at all (the daemon is
// lost). Only the first has a duration.

export type TurnTiming = Pick<SnapshotTurn, "startedAt" | "completedAt" | "status">

export type TurnClock =
  | { kind: "running", startedAt: Date, elapsedMs: number }
  | { kind: "done", startedAt: Date, durationMs: number }
  | { kind: "stopped", startedAt: Date, stoppedAt: Date }
  // lostAt is when this client saw the daemon go, absent when it never saw
  // it (it opened the thread already disconnected).
  | { kind: "stalled", startedAt: Date, lostAt?: Date }
  | { kind: "started", startedAt: Date }

export function turnClock({
  turn,
  running,
  connected,
  lostAt,
  now,
}: {
  turn: TurnTiming
  // The session says a turn is running (activeTurnId). The ledger's pending
  // alone does not make the clock run.
  running: boolean
  connected: boolean
  lostAt?: Date | undefined
  now: Date
}): TurnClock {
  const startedAt = new Date(turn.startedAt)
  if (turn.completedAt !== undefined) {
    const end = new Date(turn.completedAt)
    if (turn.status === "completed") return { kind: "done", startedAt, durationMs: end.getTime() - startedAt.getTime() }
    if (turn.status === "failed" || turn.status === "interrupted") return { kind: "stopped", startedAt, stoppedAt: end }
  }
  if (turn.status === "pending" && running) {
    if (!connected) return lostAt ? { kind: "stalled", startedAt, lostAt } : { kind: "stalled", startedAt }
    return { kind: "running", startedAt, elapsedMs: Math.max(0, now.getTime() - startedAt.getTime()) }
  }
  return { kind: "started", startedAt }
}

const clockTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })

const pad = (value: number) => String(value).padStart(2, "0")

// 38s, 1m 09s, 4m 18s, 1h 04m: the design's 1m 09s pads the smaller unit.
export function formatTurnDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

export function headerClockText(clock: TurnClock): string {
  const started = `started ${clockTime.format(clock.startedAt)}`
  switch (clock.kind) {
    case "running": return `${started} · running ${formatTurnDuration(clock.elapsedMs)}`
    case "done": return `${started} · ${formatTurnDuration(clock.durationMs)}`
    case "stopped": return `${started} · stopped ${clockTime.format(clock.stoppedAt)}`
    case "stalled": return clock.lostAt ? `${started} · stalled at ${clockTime.format(clock.lostAt)}` : `${started} · stalled`
    case "started": return started
  }
}

// The header describes the session's latest turn the snapshot carries.
export function latestSessionTurn<T extends Pick<SnapshotTurn, "sessionId" | "ordinal">>(
  turns: readonly T[] | undefined,
  sessionId: string,
): T | undefined {
  let latest: T | undefined
  for (const turn of turns ?? []) {
    if (turn.sessionId !== sessionId) continue
    if (!latest || turn.ordinal > latest.ordinal) latest = turn
  }
  return latest
}

// What the activity row says about its turn. "unknown" keeps the row's count
// label: a row whose turn has no timing, or whose end nobody saw finish
// cleanly, does not claim a duration.
export type ActivityTiming =
  | { kind: "working" }
  | { kind: "worked", duration: string }
  | { kind: "stopped" }
  | { kind: "unknown" }

export function activityTiming({ running, turn }: { running: boolean, turn?: TurnTiming | undefined }): ActivityTiming {
  if (running) return { kind: "working" }
  if (!turn) return { kind: "unknown" }
  if (turn.status === "completed" && turn.completedAt !== undefined) {
    return { kind: "worked", duration: formatTurnDuration(new Date(turn.completedAt).getTime() - new Date(turn.startedAt).getTime()) }
  }
  if (turn.status === "failed" || turn.status === "interrupted") return { kind: "stopped" }
  return { kind: "unknown" }
}
