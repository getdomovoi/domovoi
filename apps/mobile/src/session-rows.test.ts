import { demoWorkspace, type FleetEntry, type FleetMachine, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { approvalLead, elapsedLabel, sessionGroups, sessionRows, sessionsHeaderLine, waitingCount } from "./session-rows"

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

describe("approvalLead", () => {
  const at = Date.parse("2026-08-25T21:56:00.000Z")

  it("leads with the command and where it would run", () => {
    const lead = approvalLead(workspace(), at)

    expect(lead?.headline).toBe("1 approval waiting")
    expect(lead?.command).toBe("pnpm prisma migrate deploy")
    expect(lead?.context).toContain("macbook-pro-m3")
    expect(lead?.waited).toBe("4m")
  })

  it("counts them all but leads with the one waiting longest", () => {
    const snapshot = workspace()
    const first = snapshot.approvals[0]
    if (!first) throw new Error("fixture needs an approval")
    snapshot.approvals = [
      { ...first, id: "approval-recent", requestedAt: "2026-08-25T21:55:00.000Z" },
      { ...first, id: "approval-older", requestedAt: "2026-08-25T21:00:00.000Z" },
    ]

    const lead = approvalLead(snapshot, at)

    expect(lead?.headline).toBe("2 approvals waiting")
    expect(lead?.approvalId).toBe("approval-older")
  })

  it("says nothing at all when nothing is waiting", () => {
    const snapshot = workspace()
    snapshot.approvals = []

    expect(approvalLead(snapshot, at)).toBeUndefined()
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
})
