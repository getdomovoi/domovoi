import { describe, expect, it } from "vitest"

import { demoWorkspace, type WorkspaceDelta } from "@getdomovoi/protocol"

import { applyWorkspaceDelta } from "./workspace-delta.js"

describe("applyWorkspaceDelta", () => {
  it("upserts streamed entities without duplicating them", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = { ...snapshot.sessions[0]!, state: "active" as const }
    const assistant = {
      id: "assistant-turn-1",
      sessionId: session.id,
      kind: "assistant" as const,
      body: "First chunk",
      createdAt: session.updatedAt,
    }
    const delta: WorkspaceDelta = {
      session,
      thread: [assistant],
      artifacts: [],
      annotations: [],
      removedArtifactIds: [],
    }

    const first = applyWorkspaceDelta(snapshot, delta)
    const second = applyWorkspaceDelta(first, {
      ...delta,
      thread: [{ ...assistant, body: "First chunk and second chunk" }],
    })

    expect(second.sessions.find((candidate) => candidate.id === session.id)?.state).toBe("active")
    expect(second.thread.filter((item) => item.id === "assistant-turn-1")).toEqual([
      expect.objectContaining({ body: "First chunk and second chunk" }),
    ])
  })

  it("removes superseded artifacts and ignores stale sessions", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.artifacts.push({
      id: "plan-old-turn",
      sessionId: session.id,
      title: "Working plan",
      type: "plan",
      revision: 1,
      content: "Old",
    })
    const updated = applyWorkspaceDelta(snapshot, {
      session,
      thread: [],
      artifacts: [{
        id: `plan-${session.id}`,
        sessionId: session.id,
        title: "Working plan",
        type: "plan",
        revision: 2,
        content: "Current",
      }],
      annotations: [],
      removedArtifactIds: ["plan-old-turn"],
    })
    expect(updated.artifacts.map((artifact) => artifact.id)).not.toContain("plan-old-turn")
    expect(updated.artifacts).toContainEqual(expect.objectContaining({
      id: `plan-${session.id}`,
      content: "Current",
    }))

    const stale = applyWorkspaceDelta(updated, {
      session: { ...session, id: "removed-session" },
      thread: [],
      artifacts: [],
      annotations: [],
      removedArtifactIds: [],
    })
    expect(stale).toBe(updated)
  })
})
