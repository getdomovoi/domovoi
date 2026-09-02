import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import {
  applyEmergencyStopResult,
  applyConnectionSnapshot,
  applyWorkspaceSnapshot,
  claimEmergencyStop,
  isCurrentConnection,
  useWorkspace,
  visibleWorkspaceSnapshot,
} from "./use-workspace"

function FleetActionProbe() {
  const { transferSession, listDevices, revokeDevice, rotateDevice } = useWorkspace(
    "ws://127.0.0.1:47831/rpc",
    "web",
  )
  return (
    <span>
      {typeof transferSession === "function" ? " · can move a session" : ""}
      {typeof listDevices === "function" ? " · can list devices" : ""}
      {typeof revokeDevice === "function" ? " · can revoke a device" : ""}
      {typeof rotateDevice === "function" ? " · can rotate a device" : ""}
    </span>
  )
}

function SnapshotProbe() {
  const {
    emergencyStop,
    emergencyStopError,
    emergencyStopOutcome,
    emergencyStopPending,
    forkSession,
    refreshProviders,
    reconnect,
    snapshot,
  } = useWorkspace("ws://127.0.0.1:47831/rpc", "web")
  return (
    <span>
      {snapshot?.project?.name ?? "no daemon snapshot"}
      {typeof reconnect === "function" ? " · can reconnect" : ""}
      {typeof forkSession === "function" ? " · can fork" : ""}
      {typeof refreshProviders === "function" ? " · can refresh providers" : ""}
      {typeof emergencyStop === "function" ? " · can emergency stop" : ""}
      {!emergencyStopPending && !emergencyStopOutcome && !emergencyStopError
        ? " · emergency stop idle"
        : ""}
    </span>
  )
}

describe("useWorkspace", () => {
  it("does not invent workspace state before the daemon responds", () => {
    const markup = renderToStaticMarkup(<SnapshotProbe />)
    expect(markup).toContain("no daemon snapshot")
    expect(markup).toContain("can reconnect")
    expect(markup).toContain("can fork")
    expect(markup).toContain("can refresh providers")
    expect(markup).toContain("can emergency stop")
    expect(markup).toContain("emergency stop idle")
  })

  it("exposes moving a session and managing paired devices", () => {
    const markup = renderToStaticMarkup(<FleetActionProbe />)
    expect(markup).toContain("can move a session")
    expect(markup).toContain("can list devices")
    expect(markup).toContain("can revoke a device")
    expect(markup).toContain("can rotate a device")
  })

  it("does not expose a snapshot owned by another connection target", () => {
    const state = { target: "web:ws://machine-a/rpc", snapshot: demoWorkspace }
    expect(visibleWorkspaceSnapshot(state, "web:ws://machine-a/rpc")).toBe(demoWorkspace)
    expect(visibleWorkspaceSnapshot(state, "web:ws://machine-b/rpc")).toBeNull()
  })

  it("preserves the current target when an old response arrives late", () => {
    const current = { target: "web:ws://machine-b/rpc", snapshot: demoWorkspace }
    const late = structuredClone(demoWorkspace)
    late.machine.name = "machine-a"
    expect(applyWorkspaceSnapshot(current, "web:ws://machine-a/rpc", late)).toBe(current)
  })

  it("rejects completion from a replaced client", () => {
    const machineA = {}
    const machineB = {}
    expect(isCurrentConnection(machineB, machineA)).toBe(false)
    expect(isCurrentConnection(machineB, machineB)).toBe(true)
  })

  it("admits only one emergency-stop activation while one is pending", () => {
    const pending = { current: null as object | null }
    const client = {}

    expect(claimEmergencyStop(pending, client)).toBe(true)
    expect(claimEmergencyStop(pending, client)).toBe(false)
    expect(pending.current).toBe(client)
  })

  it("rejects a stale client after an A to B to A reconnect", () => {
    const oldMachineA = {}
    const currentMachineA = {}
    const state = { target: "web:ws://machine-a/rpc", snapshot: demoWorkspace }
    const late = structuredClone(demoWorkspace)
    late.machine.name = "stale-machine-a"

    expect(applyConnectionSnapshot(
      currentMachineA,
      oldMachineA,
      state,
      "web:ws://machine-a/rpc",
      late,
    )).toBe(state)
  })

  it("installs the emergency-stop snapshot only for the current connection", () => {
    const currentClient = {}
    const staleClient = {}
    const state = { target: "web:ws://machine-a/rpc", snapshot: demoWorkspace }
    const stopped = structuredClone(demoWorkspace)
    stopped.activeSessionId = "session-audit"
    const result = {
      snapshot: stopped,
      stopId: "stop-1",
      requestedAt: "2026-08-29T12:00:00.000Z",
      client: "web" as const,
      outcomes: {
        turnsStopped: 1,
        terminalsClosed: 0,
        approvalsDenied: 0,
        mutationsCancelled: 0,
        providersReset: 0,
      },
      failures: [],
    }

    expect(applyEmergencyStopResult(
      currentClient,
      currentClient,
      state,
      "web:ws://machine-a/rpc",
      result,
    ).snapshot).toBe(stopped)
    expect(applyEmergencyStopResult(
      currentClient,
      staleClient,
      state,
      "web:ws://machine-a/rpc",
      result,
    )).toBe(state)
  })
})
