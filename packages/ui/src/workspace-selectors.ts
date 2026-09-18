import type {
  FleetEntry,
  FleetMachine,
  SessionSummary,
  ThreadItem,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { boundedClientThread, protocolVersion } from "@getdomovoi/protocol"

// The handoff's machine menu reports active sessions, so sessions that are
// idle, finished, or archived are not counted as work on this machine.
export function activeSessionCount(snapshot: WorkspaceSnapshot): number {
  return snapshot.sessions.filter((session) => session.state === "active" || session.state === "waiting").length
}

// The fleet is fetched separately, so the composer still names this machine
// from the snapshot until that answer arrives.
export function localMachineEntry(snapshot: WorkspaceSnapshot): FleetMachine {
  return {
    id: snapshot.machine.id,
    label: snapshot.machine.name,
    platform: snapshot.machine.platform,
    arch: snapshot.machine.arch,
    version: snapshot.machine.version,
    connection: "local",
    capabilities: [],
    protocolVersion,
    transports: [],
    heartbeat: { state: "online", lastSeenAt: new Date(0).toISOString() },
    health: "healthy",
    self: true,
  }
}

export function localFleetEntry(snapshot: WorkspaceSnapshot): FleetEntry {
  return { kind: "machine", machine: localMachineEntry(snapshot) }
}

export function activeThreadKey(snapshot: WorkspaceSnapshot): string {
  return snapshot.activeSessionId ?? "no-active-session"
}

export function renderedThreadForActiveSession(snapshot: WorkspaceSnapshot): ThreadItem[] {
  if (!snapshot.activeSessionId) return []
  return boundedClientThread(snapshot.thread, snapshot.activeSessionId)
    .filter((item) => item.sessionId === snapshot.activeSessionId)
}

// A transferred session is a recovery point that another machine now owns, and
// a transferring one is mid-move, so both refuse mutation for the same reason
// an archived session does: this client cannot be the one that changes it.
const readOnlySessionStates = new Set<SessionSummary["state"]>([
  "archiving",
  "archived",
  "transferring",
  "transferred",
  "ownership-conflict",
])

export function activeSession(
  snapshot: WorkspaceSnapshot,
): WorkspaceSnapshot["sessions"][number] | undefined {
  return snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)
}

export function sessionIsArchiveReadOnly(
  session: WorkspaceSnapshot["sessions"][number] | undefined,
): boolean {
  return session !== undefined && readOnlySessionStates.has(session.state)
}

export function forkSessionBlockedReason(
  session: SessionSummary,
  checkpoint: ThreadItem | undefined,
): string | undefined {
  if (session.state === "archiving" || session.state === "archived") {
    return "Archived sessions cannot be forked"
  }
  if (session.state === "transferring") {
    return "This session is moving to another machine"
  }
  if (session.state === "transferred") {
    // A release is not a move that worked. Saying it moved would tell the
    // person their transfer succeeded when it was a conflict they settled.
    return session.transfer?.phase === "transferred"
      && session.transfer.completion === "conflict-released"
      ? "This machine gave up its claim on this session"
      : "This session moved to another machine"
  }
  if (session.state === "ownership-conflict") {
    return "Two machines claim this session"
  }
  if (session.activeTurnId || session.state === "active") {
    return "Stop the active turn before forking"
  }
  if (session.state === "waiting") return "Resolve the pending approval before forking"
  if (!session.workspacePath) return "This session has no isolated worktree to fork"
  if (checkpoint?.kind !== "checkpoint" || !checkpoint.commit) {
    return "Create a durable checkpoint before forking"
  }
  return undefined
}
