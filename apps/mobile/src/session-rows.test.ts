import { demoWorkspace, type FleetEntry, type FleetMachine, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { elapsedLabel, needsYouLabel, sessionGroups, sessionRows, sessionsHeaderLine, waitingCount } from "./session-rows"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("sessionRows", () => {
  it("puts what a session wants from the person on the row", () => {
    const snapshot = workspace()
    const waiting = snapshot.approvals[0]?.sessionId
    if (!waiting) throw new Error("fixture needs a pending approval")

    const rows = sessionRows(snapshot)

    expect(rows.find((row) => row.id === waiting)?.attention).toBe("approval")
    expect(rows).toHaveLength(snapshot.sessions.length)
  })

  it("counts a session once however many approvals it is holding", () => {
    const snapshot = workspace()
    const first = snapshot.approvals[0]
    if (!first) throw new Error("fixture needs a pending approval")
    snapshot.approvals = [first, { ...first, id: `${first.id}-second` }]

    expect(waitingCount(snapshot)).toBe(1)
  })

  it("says auto is on, because it changes what the session may do unattended", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")
    session.runtime = { ...session.runtime, permissionMode: "build", auto: true }

    expect(sessionRows(snapshot).find((row) => row.id === session.id)?.mode).toBe("build auto")
  })
})

describe("sessionRows ordering", () => {
  it("puts what wants a decision above what does not", () => {
    const snapshot = workspace()

    const rows = sessionRows(snapshot)
    const ranks = rows.map((row) => row.attention ?? "none")

    // Approvals first, then anything with something to review, then the rest.
    expect(ranks.indexOf("approval")).toBe(0)
    expect(ranks.lastIndexOf("approval")).toBeLessThan(
      ranks.indexOf("none") === -1 ? ranks.length : ranks.indexOf("none"),
    )
  })

  it("puts the longest waiting approval first when several are waiting", () => {
    const snapshot = workspace()
    const first = snapshot.approvals[0]
    const other = snapshot.sessions[2]
    if (!first || !other) throw new Error("fixture needs an approval and a third session")
    snapshot.approvals = [
      { ...first, requestedAt: "2026-08-25T21:52:00.000Z" },
      {
        ...first,
        id: "approval-older",
        sessionId: other.id,
        requestedAt: "2026-08-25T20:00:00.000Z",
      },
    ]

    expect(sessionRows(snapshot)[0]?.id).toBe(other.id)
  })

  it("falls back to the most recently touched session, not the snapshot's order", () => {
    const snapshot = workspace()
    snapshot.approvals = []
    snapshot.artifacts = []
    const [first, second] = snapshot.sessions
    if (!first || !second) throw new Error("fixture needs two sessions")
    first.updatedAt = "2026-08-25T10:00:00.000Z"
    second.updatedAt = "2026-08-25T23:00:00.000Z"

    expect(sessionRows(snapshot)[0]?.id).toBe(second.id)
  })
})

describe("elapsedLabel", () => {
  const at = Date.parse("2026-08-25T22:00:00.000Z")

  it("shortens the age to the largest unit that is still true", () => {
    expect(elapsedLabel("2026-08-25T21:59:30.000Z", at)).toBe("now")
    expect(elapsedLabel("2026-08-25T21:56:00.000Z", at)).toBe("4m")
    expect(elapsedLabel("2026-08-25T20:00:00.000Z", at)).toBe("2h")
    expect(elapsedLabel("2026-08-22T22:00:00.000Z", at)).toBe("3d")
  })

  it("says nothing rather than guessing at a timestamp it cannot read", () => {
    expect(elapsedLabel("not a date", at)).toBeUndefined()
  })

  it("does not report a negative age when the clocks disagree", () => {
    expect(elapsedLabel("2026-08-25T22:05:00.000Z", at)).toBe("now")
  })
})

describe("sessionGroups", () => {
  it("puts needs-you first, then running, then quiet, each with its count", () => {
    const snapshot = workspace()

    const groups = sessionGroups(snapshot)

    expect(groups.map((group) => group.id)).toEqual(["needs-you", "running", "quiet"])
    expect(groups.map((group) => group.label)).toEqual(["NEEDS YOU", "RUNNING", "QUIET"])
    expect(groups.map((group) => group.rows.length)).toEqual([1, 1, 1])
    expect(groups[0]?.rows[0]?.id).toBe(snapshot.approvals[0]?.sessionId)
  })

  it("drops a group with nothing in it rather than drawing an empty heading", () => {
    const snapshot = workspace()
    snapshot.approvals = []

    const groups = sessionGroups(snapshot)

    expect(groups.map((group) => group.id)).toEqual(["running", "quiet"])
  })

  it("keeps a running session in needs-you while it holds an approval", () => {
    const snapshot = workspace()
    const waiting = snapshot.sessions.find((session) => session.id === snapshot.approvals[0]?.sessionId)
    if (!waiting) throw new Error("fixture needs a pending approval")
    waiting.state = "active"

    const groups = sessionGroups(snapshot)

    expect(groups[0]?.id).toBe("needs-you")
    expect(groups[0]?.rows.map((row) => row.id)).toEqual([waiting.id])
    expect(groups.find((group) => group.id === "running")?.rows.map((row) => row.id)).not.toContain(waiting.id)
  })

  // The clock a waiting row shows starts when the approval was raised. A row
  // that waits on nobody has no such moment.
  it("carries when a session started waiting on you, and nothing for the rest", () => {
    const snapshot = workspace()
    const approval = snapshot.approvals[0]
    if (!approval) throw new Error("fixture needs a pending approval")

    const rows = sessionGroups(snapshot).flatMap((group) => group.rows)

    expect(rows.find((row) => row.id === approval.sessionId)?.waitingSince).toBe(approval.requestedAt)
    expect(rows.filter((row) => row.id !== approval.sessionId).map((row) => row.waitingSince)).toEqual(
      rows.filter((row) => row.id !== approval.sessionId).map(() => undefined),
    )
  })

  // A session holding two approvals has waited since the first of them, in
  // whatever order the snapshot lists them.
  it("starts a session's clock at its earliest waiting approval", () => {
    const snapshot = workspace()
    const first = snapshot.approvals[0]
    if (!first) throw new Error("fixture needs a pending approval")
    const earlier = new Date(Date.parse(first.requestedAt) - 10 * 60_000).toISOString()
    // Listed before the later one, so keeping the last one seen would be wrong.
    snapshot.approvals.unshift({ ...first, id: `${first.id}-earlier`, requestedAt: earlier })

    const rows = sessionGroups(snapshot).flatMap((group) => group.rows)

    expect(rows.find((row) => row.id === first.sessionId)?.waitingSince).toBe(earlier)
  })
})

// The sessions on this screen are one machine's. A running count is a fact
// about that machine, so the line names it; the fleet count says how many
// machines answered, because no results and not searched are different
// answers and a total would round the second down to the first.
describe("sessionsHeaderLine", () => {
  const machine = (label: string, health: FleetMachine["health"]): FleetEntry => ({
    kind: "machine",
    machine: {
      id: `machine-${label.padEnd(32, "0")}`, label, platform: "linux", arch: "x64", version: "0.0.1",
      connection: "tailnet", capabilities: ["sessions"], protocolVersion: "0.2.0", transports: [],
      heartbeat: { state: health === "unreachable" ? "offline" : "online", lastSeenAt: "2026-09-18T00:00:00.000Z" },
      health, self: false,
    },
  })

  it("names the machine and scopes the running count to it", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.sessions = snapshot.sessions.map((session) => ({ ...session, state: "idle" as const, activeTurnId: undefined }))
    expect(sessionsHeaderLine(snapshot, undefined)).toBe(`${snapshot.machine.name} · none running`)
  })

  it("says how many of the fleet answered instead of a total", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.sessions = snapshot.sessions.map((session) => ({ ...session, state: "idle" as const, activeTurnId: undefined }))
    const line = sessionsHeaderLine(snapshot, [machine("a", "healthy"), machine("b", "healthy"), machine("c", "unreachable")])
    expect(line).toBe(`${snapshot.machine.name} · none running · 2 reachable · 1 offline`)
    expect(line).not.toMatch(/3 machines/)
  })

  // Walk F12: while the phone is not live the counts are the last read, not
  // now. The line says so, with the time the phone received it, and drops the
  // fleet part: "reachable" is a claim about now.
  it("says the counts are from the last read while not live, and drops the fleet", () => {
    const snapshot = structuredClone(demoWorkspace)
    const fleet = [machine("a", "healthy"), machine("b", "unreachable")]
    const readAt = new Date(2026, 9, 15, 14, 7, 30).getTime()
    const now = new Date(2026, 9, 15, 16, 0, 0).getTime()

    expect(sessionsHeaderLine(snapshot, fleet, { readAt, now }))
      .toBe(`${snapshot.machine.name} · 1 running when last read at 14:07`)
    expect(sessionsHeaderLine(snapshot, fleet, { readAt: undefined, now }))
      .toBe(`${snapshot.machine.name} · 1 running when last read`)

    snapshot.sessions = snapshot.sessions.map((session) => ({ ...session, state: "idle" as const, activeTurnId: undefined }))
    expect(sessionsHeaderLine(snapshot, fleet, { readAt, now }))
      .toBe(`${snapshot.machine.name} · none running when last read at 14:07`)
  })

  // A clock alone reads as today. A read from another day names the day.
  it("names the day of a last read that was not today", () => {
    const snapshot = structuredClone(demoWorkspace)
    const readAt = new Date(2026, 9, 12, 9, 5, 0).getTime()
    const now = new Date(2026, 9, 15, 16, 0, 0).getTime()
    expect(sessionsHeaderLine(snapshot, undefined, { readAt, now }))
      .toBe(`${snapshot.machine.name} · 1 running when last read on 12 Oct at 09:05`)
  })
})

// Walk F19: one session needs you; two need you.
describe("needsYouLabel", () => {
  it("agrees with its count", () => {
    expect(needsYouLabel(1)).toBe("1 needs you")
    expect(needsYouLabel(2)).toBe("2 need you")
  })
})
