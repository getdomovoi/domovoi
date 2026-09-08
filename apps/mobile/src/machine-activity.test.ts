import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { connectedMachineActivity } from "./machine-activity"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("connectedMachineActivity", () => {
  it("names the machine the snapshot describes, so no other row can claim it", () => {
    const snapshot = workspace()
    expect(connectedMachineActivity(snapshot).machineId).toBe(snapshot.machine.id)
  })

  it("counts the sessions the Sessions tab lists, so the two cannot disagree", () => {
    const snapshot = workspace()
    expect(connectedMachineActivity(snapshot).sessions).toBe(snapshot.sessions.length)

    snapshot.sessions = snapshot.sessions.slice(0, 1)
    expect(connectedMachineActivity(snapshot).sessions).toBe(1)

    snapshot.sessions = []
    expect(connectedMachineActivity(snapshot).sessions).toBe(0)
  })

  it("leads with a waiting approval, because it is what wants a person", () => {
    const snapshot = workspace()
    const waiting = snapshot.approvals[0]
    if (!waiting) throw new Error("fixture needs a pending approval")

    expect(connectedMachineActivity(snapshot)).toMatchObject({
      tools: "1 approval",
      attention: true,
    })

    snapshot.approvals = [waiting, { ...waiting, id: `${waiting.id}-second` }]
    expect(connectedMachineActivity(snapshot).tools).toBe("2 approvals")
  })

  it("says a turn is running only when no approval is holding one up", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")
    snapshot.approvals = []
    snapshot.sessions = [{ ...session, state: "active" }]

    expect(connectedMachineActivity(snapshot)).toMatchObject({
      tools: "running",
      attention: false,
    })
  })

  it("says idle when nothing is waiting and nothing is running", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")
    snapshot.approvals = []
    snapshot.sessions = [{ ...session, state: "idle" }]

    expect(connectedMachineActivity(snapshot)).toMatchObject({
      tools: "idle",
      attention: false,
    })
  })
})
