import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { approvalLead, elapsedLabel, sessionRows, waitingCount } from "./session-rows"

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
