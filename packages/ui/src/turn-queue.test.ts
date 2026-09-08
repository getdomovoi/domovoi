import { describe, expect, it } from "vitest"

import {
  heldAfter,
  heldAfterStop,
  holdAllAfterStop,
  releasableQueues,
  setQueue,
  shouldRelease,
  type QueuedMessage,
  type SessionQueues,
} from "./turn-queue"

function waiting(sessionId: string, text = "run it"): QueuedMessage {
  return { sessionId, text, state: "waiting" }
}

describe("what may leave the queue", () => {
  it("releases a session whose turn ended even when another is on screen", () => {
    const queues: SessionQueues = { a: waiting("a", "for A"), b: waiting("b", "for B") }
    const ready = releasableQueues([{ id: "a" }, { id: "b", activeTurnId: "turn-1" }], queues, { busy: false })
    expect(ready.map((message) => message.text)).toEqual(["for A"])
  })

  it("keeps one slot per session rather than one slot", () => {
    let queues = setQueue({}, "a", waiting("a", "for A"))
    queues = setQueue(queues, "b", waiting("b", "for B"))
    // Queueing in B must not overwrite what is still waiting in A.
    expect(queues.a?.text).toBe("for A")
    expect(queues.b?.text).toBe("for B")
    expect(setQueue(queues, "b", undefined).a?.text).toBe("for A")
  })

  it("holds every session's queue when work is stopped", () => {
    const held = holdAllAfterStop({ a: waiting("a"), b: waiting("b") })
    expect(Object.values(held).every((message) => message.state === "held")).toBe(true)
    expect(releasableQueues([{ id: "a" }, { id: "b" }], held, { busy: false })).toEqual([])
  })

  it("leaves an already held message alone rather than restating why", () => {
    const already = heldAfter(waiting("a"), "Held because sending failed.")
    expect(heldAfterStop(already)).toBe(already)
  })

  it("never releases a held message on its own", () => {
    const held = heldAfter(waiting("a"), "Held because sending failed.")
    expect(shouldRelease({ queued: held, sessionId: "a", turnRunning: false, busy: false })).toBe(false)
    expect(shouldRelease({ queued: waiting("a"), sessionId: "a", turnRunning: false, busy: false })).toBe(true)
  })

  it("never releases into a session it was not typed in", () => {
    expect(releasableQueues([{ id: "b" }], { a: waiting("a") }, { busy: false })).toEqual([])
  })

  it("waits while a turn is running or a stop is in flight", () => {
    const queues: SessionQueues = { a: waiting("a") }
    expect(releasableQueues([{ id: "a", activeTurnId: "turn-1" }], queues, { busy: false })).toEqual([])
    expect(releasableQueues([{ id: "a" }], queues, { busy: true })).toEqual([])
  })
})
