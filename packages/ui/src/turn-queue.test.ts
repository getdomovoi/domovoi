import type { ProviderModel, SessionAttachment } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  carriesImages,
  heldAfter,
  imageRelease,
  noteImageRefusals,
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

describe("images and a model that takes none", () => {
  const image: SessionAttachment = { mimeType: "image/png", width: 2, height: 2, data: "iVBORw0KGgo=" }
  const notes: SessionAttachment = { kind: "workspace-file", path: "src/notes.ts" }
  const runtime = { provider: "claude-code", model: "sonnet-4.6" }
  function model(id: string, imageInput: boolean | undefined, provider = "claude-code"): ProviderModel {
    return {
      provider, id, displayName: id, description: "", supportedReasoningEfforts: [], isDefault: false,
      ...(imageInput === undefined ? {} : { imageInput }),
    }
  }
  const withImage: QueuedMessage = { ...waiting("a"), attachments: [notes, image] }

  it("counts images, not text files, as what a model may refuse", () => {
    expect(carriesImages(withImage)).toBe(true)
    expect(carriesImages({ ...waiting("a"), attachments: [notes] })).toBe(false)
    expect(carriesImages(waiting("a"))).toBe(false)
  })

  // A read that started at ticket 5, the turn boundary.
  const pending = { since: 5, settled: false }
  const settled = { since: 5, settled: true }
  const refusedAt = (ticket: number, id = "sonnet-4.6", provider = "claude-code") =>
    noteImageRefusals({}, [model(id, false, provider)], ticket)

  it("releases a message without images whatever the catalog says", () => {
    expect(imageRelease(waiting("a"), runtime, {}, pending)).toBe("release")
    expect(imageRelease({ ...waiting("a"), attachments: [notes] }, runtime, refusedAt(6), settled)).toBe("release")
  })

  // The daemon asks the adapter on every catalog read, and the answer can
  // change while a turn runs, so only a read started at the boundary counts.
  it("waits for the read started at the turn boundary", () => {
    expect(imageRelease(withImage, runtime, {}, pending)).toBe("wait")
    expect(imageRelease(withImage, runtime, refusedAt(4), pending)).toBe("wait")
    expect(imageRelease(withImage, runtime, refusedAt(4), settled)).toBe("release")
  })

  it("holds at once on a no from any read started after the boundary", () => {
    expect(imageRelease(withImage, runtime, refusedAt(6), pending)).toBe("hold")
    expect(imageRelease(withImage, runtime, refusedAt(6), settled)).toBe("hold")
  })

  it("holds only for the session's own model", () => {
    expect(imageRelease(withImage, runtime, refusedAt(6, "opus-4.6"), settled)).toBe("release")
    expect(imageRelease(withImage, runtime, refusedAt(6, "sonnet-4.6", "codex"), settled)).toBe("release")
  })

  it("notes only explicit refusals, each at its newest read", () => {
    const noted = noteImageRefusals(refusedAt(7), [model("sonnet-4.6", false), model("opus-4.6", undefined), model("haiku-4.5", true)], 3)
    expect(noted).toEqual({ "claude-code\nsonnet-4.6": 7 })
    const unchanged = refusedAt(7)
    expect(noteImageRefusals(unchanged, [model("opus-4.6", true)], 9)).toBe(unchanged)
  })
})
