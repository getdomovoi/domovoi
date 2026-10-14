import type { ProviderModel, SessionAttachment } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  carriesImages,
  heldAfter,
  imageRelease,
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

  const answer = (ticket: number, imageInput: boolean | undefined, id = "sonnet-4.6", provider = "claude-code") =>
    ({ ticket, models: [model(id, imageInput, provider)] })
  const settled = (...answers: ReturnType<typeof answer>[]) => ({ answers, settled: true })

  it("releases a message without images whatever the catalog says", () => {
    expect(imageRelease(waiting("a"), runtime, { answers: [], settled: false })).toBe("release")
    expect(imageRelease({ ...waiting("a"), attachments: [notes] }, runtime, settled(answer(1, false)))).toBe("release")
  })

  // The daemon reads the adapter's capability on every catalog request, so an
  // older yes from another reader does not stand in for the release's own read.
  it("waits for the release's own read unless a no is already known", () => {
    expect(imageRelease(withImage, runtime, { answers: [], settled: false })).toBe("wait")
    expect(imageRelease(withImage, runtime, { answers: [answer(1, true)], settled: false })).toBe("wait")
    expect(imageRelease(withImage, runtime, { answers: [answer(1, false)], settled: false })).toBe("hold")
  })

  it("holds only when the session's own model says it takes no images", () => {
    expect(imageRelease(withImage, runtime, settled(answer(1, false)))).toBe("hold")
    expect(imageRelease(withImage, runtime, settled(answer(1, true)))).toBe("release")
    expect(imageRelease(withImage, runtime, settled(answer(1, false, "opus-4.6")))).toBe("release")
    expect(imageRelease(withImage, runtime, settled(answer(1, false, "sonnet-4.6", "codex")))).toBe("release")
  })

  // The composer, the launcher and the release each read for themselves.
  // Capability can change between reads, so the newest explicit answer wins,
  // and a newer "not said" does not undo an older explicit one.
  it("follows the newest explicit answer across readers", () => {
    expect(imageRelease(withImage, runtime, settled(answer(1, false), answer(2, true)))).toBe("release")
    expect(imageRelease(withImage, runtime, settled(answer(2, false), answer(1, true)))).toBe("hold")
    expect(imageRelease(withImage, runtime, settled(answer(1, false), answer(2, undefined)))).toBe("hold")
  })

  it("does not hold on what is not known", () => {
    expect(imageRelease(withImage, runtime, settled(answer(1, undefined)))).toBe("release")
    expect(imageRelease(withImage, runtime, settled())).toBe("release")
  })
})
