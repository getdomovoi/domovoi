import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { sessionRows, waitingCount } from "./session-rows"

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

    expect(sessionRows(snapshot)[0]?.mode).toBe("build auto")
  })
})
