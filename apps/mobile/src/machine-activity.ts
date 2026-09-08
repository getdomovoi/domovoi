import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

export type MachineActivity = {
  // Which machine these counts describe. The phone holds one daemon's snapshot
  // and the snapshot names its own machine, so only the fleet row carrying that
  // id may show them.
  machineId: string
  sessions: number
  // What the machine is doing with its agents, in the words the handoff uses:
  // a waiting approval outranks a running turn, and neither outranks the other
  // being absent.
  tools: string
  attention: boolean
}

// The two per-machine facts the handoff puts on a fleet card, for the one
// machine this phone can learn them about. `fleet.list` carries no session or
// tool counts, so every other row goes without rather than borrowing these.
export function connectedMachineActivity(snapshot: WorkspaceSnapshot): MachineActivity {
  const waiting = snapshot.approvals.length
  const running = snapshot.sessions.some((session) => session.state === "active")
  return {
    machineId: snapshot.machine.id,
    // The same list the Sessions tab draws, so the two tabs cannot disagree
    // about how many sessions this machine is holding.
    sessions: snapshot.sessions.length,
    tools: waiting > 0
      ? `${waiting} approval${waiting === 1 ? "" : "s"}`
      : running ? "running" : "idle",
    attention: waiting > 0,
  }
}
