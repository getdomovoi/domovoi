import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { queuedCancelParams, sendDelivery } from "./session-delivery"

describe("session delivery", () => {
  it("uses next-turn replacement only while a turn is active", () => {
    const active = structuredClone(demoWorkspace.sessions[0])
    if (!active) throw new Error("fixture needs a session")
    active.activeTurnId = "turn-1"
    expect(sendDelivery(active)).toEqual({ delivery: "next-turn-replace" })
    active.activeTurnId = undefined
    expect(sendDelivery(active)).toEqual({})
  })

  it("cancels only when both session and queue ids still match canonical state", () => {
    const queued = {
      id: "queue-1",
      sessionId: "session-billing",
      state: "waiting" as const,
      createdAt: "2026-09-19T23:00:00.000Z",
      origin: { client: "phone" as const, connectionId: "connection-1" },
      skillIds: [],
      attachments: [],
    }
    expect(queuedCancelParams(queued, "session-billing", "queue-1")).toEqual({
      sessionId: "session-billing",
      queueId: "queue-1",
      client: "phone",
    })
    expect(queuedCancelParams(queued, "session-other", "queue-1")).toBeUndefined()
    expect(queuedCancelParams(queued, "session-billing", "queue-stale")).toBeUndefined()
  })
})
