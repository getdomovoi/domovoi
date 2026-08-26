import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import {
  applyWorkspaceSnapshot,
  useWorkspace,
  visibleWorkspaceSnapshot,
} from "./use-workspace"

function SnapshotProbe() {
  const { snapshot } = useWorkspace("ws://127.0.0.1:47831/rpc", "web")
  return <span>{snapshot?.project?.name ?? "no daemon snapshot"}</span>
}

describe("useWorkspace", () => {
  it("does not invent workspace state before the daemon responds", () => {
    expect(renderToStaticMarkup(<SnapshotProbe />)).toContain("no daemon snapshot")
  })

  it("does not expose a snapshot owned by another connection target", () => {
    const state = { target: "web:ws://machine-a/rpc", snapshot: demoWorkspace }

    expect(visibleWorkspaceSnapshot(state, "web:ws://machine-a/rpc")).toBe(demoWorkspace)
    expect(visibleWorkspaceSnapshot(state, "web:ws://machine-b/rpc")).toBeNull()
  })

  it("preserves the current target when an old response arrives late", () => {
    const current = {
      target: "web:ws://machine-b/rpc",
      snapshot: demoWorkspace,
    }
    const late = structuredClone(demoWorkspace)
    late.machine.name = "machine-a"

    expect(applyWorkspaceSnapshot(current, "web:ws://machine-a/rpc", late)).toBe(current)
  })
})
