import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { tabletSessionId } from "./tablet-session"

describe("tabletSessionId", () => {
  it.each([undefined, "session-removed"])("falls back from selection %s to the active or first session", (selected) => {
    const snapshot = structuredClone(demoWorkspace)
    const [first, second] = snapshot.sessions
    if (!first || !second) throw new Error("fixture needs two sessions")
    snapshot.activeSessionId = second.id
    expect(tabletSessionId(snapshot, selected)).toBe(second.id)
    snapshot.activeSessionId = null
    expect(tabletSessionId(snapshot, selected)).toBe(first.id)
    snapshot.sessions = []
    expect(tabletSessionId(snapshot, selected)).toBeUndefined()
  })

  it("keeps an existing selection ahead of the active session", () => {
    const snapshot = structuredClone(demoWorkspace)
    const [first, second] = snapshot.sessions
    if (!first || !second) throw new Error("fixture needs two sessions")
    snapshot.activeSessionId = first.id
    expect(tabletSessionId(snapshot, second.id)).toBe(second.id)
  })
})
