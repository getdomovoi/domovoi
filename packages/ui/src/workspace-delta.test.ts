import { describe, expect, it } from "vitest"

import { demoWorkspace, maximumEffectiveClientThreadItems, type WorkspaceDelta } from "@getdomovoi/protocol"

import { applyWorkspaceDelta } from "./workspace-delta.js"

describe("applyWorkspaceDelta", () => {
  it("keeps delta-applied thread state at the effective rendered cap", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    snapshot.activeSessionId = session.id
    snapshot.thread = Array.from({ length: maximumEffectiveClientThreadItems }, (_, index) => ({
      id: `message-${index}`,
      sessionId: session.id,
      kind: "user" as const,
      body: `Message ${index}`,
      createdAt: session.updatedAt,
    }))

    const updated = applyWorkspaceDelta(snapshot, {
      sessionId: session.id,
      updatedAt: session.updatedAt,
      operations: [{
        kind: "assistant.append",
        id: "latest-message",
        delta: "Latest",
        createdAt: session.updatedAt,
      }],
    })

    expect(updated.thread).toHaveLength(maximumEffectiveClientThreadItems)
    expect(updated.thread[0]?.id).toBe("message-1")
    expect(updated.thread.at(-1)?.id).toBe("latest-message")
  })

  it("appends streamed chunks without duplicating entities", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    const first: WorkspaceDelta = {
      sessionId: session.id,
      updatedAt: session.updatedAt,
      operations: [{
        kind: "assistant.append",
        id: "assistant-turn-1",
        delta: "First chunk",
        createdAt: session.updatedAt,
      }],
    }

    const updated = applyWorkspaceDelta(applyWorkspaceDelta(snapshot, first), {
      ...first,
      operations: [{
        kind: "assistant.append",
        id: "assistant-turn-1",
        delta: " and second chunk",
        createdAt: session.updatedAt,
      }],
    })

    expect(updated.thread.filter((item) => item.id === "assistant-turn-1")).toEqual([
      expect.objectContaining({ body: "First chunk and second chunk" }),
    ])
  })

  it("creates and appends plan artifacts while ignoring stale sessions", () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    const delta: WorkspaceDelta = {
      sessionId: session.id,
      updatedAt: session.updatedAt,
      operations: [{
        kind: "plan.append",
        id: `plan-${session.id}`,
        delta: "1. Inspect.\n",
        revision: 1,
      }],
    }
    const updated = applyWorkspaceDelta(applyWorkspaceDelta(snapshot, delta), {
      ...delta,
      operations: [{
        kind: "plan.append",
        id: `plan-${session.id}`,
        delta: "2. Verify.",
        revision: 2,
      }],
    })
    expect(updated.artifacts).toContainEqual(expect.objectContaining({
      id: `plan-${session.id}`,
      content: "1. Inspect.\n2. Verify.",
      revision: 2,
    }))

    const stale = applyWorkspaceDelta(updated, { ...delta, sessionId: "removed-session" })
    expect(stale).toBe(updated)
  })
})
