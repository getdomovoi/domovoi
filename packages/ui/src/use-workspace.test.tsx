import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import {
  applyConnectionSnapshot,
  applyWorkspaceSnapshot,
  isCurrentConnection,
  useWorkspace,
  visibleWorkspaceSnapshot,
} from "./use-workspace"

function SnapshotProbe() {
  const { forkSession, reconnect, snapshot } = useWorkspace("ws://127.0.0.1:47831/rpc", "web")
  return (
    <span>
      {snapshot?.project?.name ?? "no daemon snapshot"}
      {typeof reconnect === "function" ? " · can reconnect" : ""}
      {typeof forkSession === "function" ? " · can fork" : ""}
    </span>
  )
}

describe("useWorkspace", () => {
  it("does not invent workspace state before the daemon responds", () => {
    const markup = renderToStaticMarkup(<SnapshotProbe />)
    expect(markup).toContain("no daemon snapshot")
    expect(markup).toContain("can reconnect")
    expect(markup).toContain("can fork")
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
})
