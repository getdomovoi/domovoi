import {
  demoWorkspace,
  maximumEffectiveClientThreadItems,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { isPausable, sessionDetail, threadEntries } from "./session-detail"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("threadEntries", () => {
  it("keeps only the session being read", () => {
    const snapshot = workspace()
    const other = snapshot.thread[0]
    if (!other) throw new Error("fixture needs a thread")
    snapshot.thread = [
      ...snapshot.thread,
      { ...other, id: "thread-elsewhere", sessionId: "session-audit" },
    ]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries.some((entry) => entry.id === "thread-elsewhere")).toBe(false)
    expect(entries.length).toBeGreaterThan(0)
  })

  it("says how many items it dropped rather than starting silently mid-thread", () => {
    const snapshot = workspace()
    const item = snapshot.thread.find((candidate) => candidate.kind === "assistant")
    if (!item) throw new Error("fixture needs an assistant item")
    const extra = maximumEffectiveClientThreadItems + 5
    snapshot.thread = Array.from({ length: extra }, (_value, index) => ({
      ...item,
      id: `thread-bulk-${index}`,
    }))

    const { entries, omitted } = threadEntries(snapshot, "session-billing")

    expect(entries).toHaveLength(maximumEffectiveClientThreadItems)
    expect(omitted).toBe(extra - maximumEffectiveClientThreadItems)
  })

  it("gives every thread kind a voice and a body", () => {
    const snapshot = workspace()
    snapshot.thread = [
      {
        id: "t-receipt",
        sessionId: "session-billing",
        kind: "receipt",
        decision: "deny",
        operation: "Apply a production database migration",
        checkpoint: "ckpt_7f21",
        client: "phone",
        createdAt: "2026-08-25T21:52:00.000Z",
      },
      {
        id: "t-tool",
        sessionId: "session-billing",
        kind: "tool",
        tool: "command",
        status: "failed",
        title: "pnpm test",
        createdAt: "2026-08-25T21:52:00.000Z",
      },
    ]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries[0]).toEqual({
      id: "t-receipt",
      voice: "note",
      body: "Denied: Apply a production database migration",
      meta: "phone · ckpt_7f21",
    })
    expect(entries[1]?.meta).toBe("command · failed")
  })
})

describe("sessionDetail", () => {
  it("carries the pending approval so the decision stays one tap away", () => {
    const snapshot = workspace()

    expect(sessionDetail(snapshot, "session-billing")?.approvalId).toBe("approval-migrate")
    expect(sessionDetail(snapshot, "session-audit")?.approvalId).toBeUndefined()
  })

  it("returns nothing for a session this snapshot does not have", () => {
    expect(sessionDetail(workspace(), "session-missing")).toBeUndefined()
  })
})

describe("isPausable", () => {
  it("needs a provider thread and a turn, because that is what a pause stops", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")

    expect(isPausable(session)).toBe(false)

    session.providerThreadId = "thread-billing"
    session.activeTurnId = "turn-1"
    expect(isPausable(session)).toBe(true)
  })

  it("refuses a read-only session, which the daemon would refuse too", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")
    session.providerThreadId = "thread-billing"
    session.activeTurnId = "turn-1"
    session.state = "archiving"

    expect(isPausable(session)).toBe(false)
  })
})
