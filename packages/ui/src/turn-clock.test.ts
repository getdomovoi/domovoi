import { describe, expect, it } from "vitest"

import { activityTiming, formatTurnDuration, headerClockText, latestSessionTurn, turnClock } from "./turn-clock"

const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
const at = (iso: string) => hm.format(new Date(iso))

describe("formatTurnDuration", () => {
  it("draws seconds alone under a minute", () => {
    expect(formatTurnDuration(38_000)).toBe("38s")
    expect(formatTurnDuration(0)).toBe("0s")
  })

  it("pads the seconds once there are minutes, as the design draws 1m 09s", () => {
    expect(formatTurnDuration(69_000)).toBe("1m 09s")
    expect(formatTurnDuration(258_000)).toBe("4m 18s")
  })

  it("moves to hours and minutes past an hour", () => {
    expect(formatTurnDuration(3_840_000)).toBe("1h 04m")
  })

  it("never draws a negative duration", () => {
    expect(formatTurnDuration(-5_000)).toBe("0s")
  })
})

describe("turnClock", () => {
  const startedAt = "2026-10-12T14:02:00.000Z"
  const now = new Date("2026-10-12T14:03:09.000Z")

  it("runs from the start while the session says a turn is running", () => {
    expect(turnClock({ turn: { startedAt, status: "pending" }, running: true, connected: true, now })).toEqual({
      kind: "running", startedAt: new Date(startedAt), elapsedMs: 69_000,
    })
  })

  it("gives a completed turn its duration from its own start and end", () => {
    const turn = { startedAt, completedAt: "2026-10-12T14:06:18.000Z", status: "completed" as const }
    expect(turnClock({ turn, running: false, connected: true, now })).toEqual({
      kind: "done", startedAt: new Date(startedAt), durationMs: 258_000,
    })
  })

  it("says when a failed or interrupted turn stopped", () => {
    for (const status of ["failed", "interrupted"] as const) {
      const turn = { startedAt, completedAt: "2026-10-12T14:03:00.000Z", status }
      expect(turnClock({ turn, running: false, connected: true, now })).toEqual({
        kind: "stopped", startedAt: new Date(startedAt), stoppedAt: new Date("2026-10-12T14:03:00.000Z"),
      })
    }
  })

  // A turn that was running when the daemon itself stopped has no end: nobody
  // knows when it ended, so the clock shows the start and nothing else.
  it("invents no end for a turn whose end nobody saw", () => {
    expect(turnClock({ turn: { startedAt, status: "interrupted" }, running: false, connected: true, now })).toEqual({
      kind: "started", startedAt: new Date(startedAt),
    })
  })

  it("does not run a turn the session no longer says is running", () => {
    expect(turnClock({ turn: { startedAt, status: "pending" }, running: false, connected: true, now })).toEqual({
      kind: "started", startedAt: new Date(startedAt),
    })
  })

  it("stalls a running turn when the daemon is lost, at the moment it was lost", () => {
    const lostAt = new Date("2026-10-12T14:06:00.000Z")
    expect(turnClock({ turn: { startedAt, status: "pending" }, running: true, connected: false, lostAt, now })).toEqual({
      kind: "stalled", startedAt: new Date(startedAt), lostAt,
    })
  })

  it("stalls with no time when nobody saw the daemon go", () => {
    expect(turnClock({ turn: { startedAt, status: "pending" }, running: true, connected: false, now })).toEqual({
      kind: "stalled", startedAt: new Date(startedAt),
    })
  })

  it("keeps a finished turn's duration while the daemon is lost", () => {
    const turn = { startedAt, completedAt: "2026-10-12T14:06:18.000Z", status: "completed" as const }
    expect(turnClock({ turn, running: false, connected: false, now })).toMatchObject({ kind: "done", durationMs: 258_000 })
  })

  it("reads a start on another machine's clock as no time yet, not a negative one", () => {
    const early = new Date("2026-10-12T14:01:00.000Z")
    expect(turnClock({ turn: { startedAt, status: "pending" }, running: true, connected: true, now: early })).toMatchObject({ kind: "running", elapsedMs: 0 })
  })
})

describe("headerClockText", () => {
  const startedAt = new Date("2026-10-12T14:02:00.000Z")
  const started = `started ${at("2026-10-12T14:02:00.000Z")}`

  it("draws the four states as the design does", () => {
    expect(headerClockText({ kind: "running", startedAt, elapsedMs: 69_000 })).toBe(`${started} · running 1m 09s`)
    expect(headerClockText({ kind: "done", startedAt, durationMs: 258_000 })).toBe(`${started} · 4m 18s`)
    expect(headerClockText({ kind: "stopped", startedAt, stoppedAt: new Date("2026-10-12T14:03:00.000Z") })).toBe(`${started} · stopped ${at("2026-10-12T14:03:00.000Z")}`)
    expect(headerClockText({ kind: "stalled", startedAt, lostAt: new Date("2026-10-12T14:06:00.000Z") })).toBe(`${started} · stalled at ${at("2026-10-12T14:06:00.000Z")}`)
  })

  it("says stalled without a time it does not have", () => {
    expect(headerClockText({ kind: "stalled", startedAt })).toBe(`${started} · stalled`)
  })

  it("draws the start alone when the end is unknown", () => {
    expect(headerClockText({ kind: "started", startedAt })).toBe(started)
  })
})

describe("latestSessionTurn", () => {
  const turn = (id: string, sessionId: string, ordinal: number) => ({
    id, sessionId, ordinal, startedAt: "2026-10-12T14:02:00.000Z", status: "completed" as const, completedAt: "2026-10-12T14:03:00.000Z",
  })

  it("picks the session's turn with the highest ordinal", () => {
    const turns = [turn("a", "s1", 1), turn("b", "s1", 3), turn("c", "s2", 9), turn("d", "s1", 2)]
    expect(latestSessionTurn(turns, "s1")?.id).toBe("b")
  })

  it("has no turn when the snapshot carries none", () => {
    expect(latestSessionTurn(undefined, "s1")).toBeUndefined()
    expect(latestSessionTurn([turn("c", "s2", 1)], "s1")).toBeUndefined()
  })
})

describe("activityTiming", () => {
  it("is Working while the row runs", () => {
    expect(activityTiming({ running: true })).toEqual({ kind: "working" })
  })

  it("is Worked for N from a completed turn's own start and end", () => {
    const turn = { startedAt: "2026-10-12T14:02:00.000Z", completedAt: "2026-10-12T14:06:18.000Z", status: "completed" as const }
    expect(activityTiming({ running: false, turn })).toEqual({ kind: "worked", duration: "4m 18s" })
  })

  it("is Stopped for a failed or interrupted turn", () => {
    expect(activityTiming({ running: false, turn: { startedAt: "2026-10-12T14:02:00.000Z", completedAt: "2026-10-12T14:03:00.000Z", status: "failed" } })).toEqual({ kind: "stopped" })
    expect(activityTiming({ running: false, turn: { startedAt: "2026-10-12T14:02:00.000Z", status: "interrupted" } })).toEqual({ kind: "stopped" })
  })

  // No timing, or a turn still pending in the ledger while the row is not
  // running: the row keeps its count rather than a duration nobody knows.
  it("is unknown when the turn has no timing", () => {
    expect(activityTiming({ running: false })).toEqual({ kind: "unknown" })
    expect(activityTiming({ running: false, turn: { startedAt: "2026-10-12T14:02:00.000Z", status: "pending" } })).toEqual({ kind: "unknown" })
  })
})
