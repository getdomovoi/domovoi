import type { SessionAttachment } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { createSessionDraftStore, emptySessionDraft, maximumRetainedSessionDrafts } from "./session-draft"

function attachment(path: string): SessionAttachment {
  return { kind: "workspace-file", path }
}

describe("session draft store", () => {
  it("gives an empty draft for a session it has never seen", () => {
    const store = createSessionDraftStore()
    expect(store.read("s1")).toEqual(emptySessionDraft)
  })

  it("gives back what was written for that session", () => {
    const store = createSessionDraftStore()
    store.write("s1", { prompt: "half a thought", attachments: [attachment("src/a.ts")], skillSelection: new Set(["review"]), promptEditorOpen: true })
    const draft = store.read("s1")
    expect(draft.prompt).toBe("half a thought")
    expect(draft.attachments).toEqual([attachment("src/a.ts")])
    expect(draft.skillSelection).toEqual(new Set(["review"]))
    expect(draft.promptEditorOpen).toBe(true)
  })

  it("holds an open prompt editor even with nothing typed into it yet", () => {
    const store = createSessionDraftStore()
    store.write("s1", { ...emptySessionDraft, promptEditorOpen: true })
    expect(store.read("s1").promptEditorOpen).toBe(true)
    expect(store.size()).toBe(1)
  })

  it("keeps each session's draft apart", () => {
    const store = createSessionDraftStore()
    store.write("s1", { ...emptySessionDraft, prompt: "for one" })
    store.write("s2", { ...emptySessionDraft, prompt: "for two" })
    expect(store.read("s1").prompt).toBe("for one")
    expect(store.read("s2").prompt).toBe("for two")
  })

  it("holds nothing for a workspace with no active session", () => {
    const store = createSessionDraftStore()
    store.write(null, { ...emptySessionDraft, prompt: "nowhere to put this" })
    expect(store.read(null)).toEqual(emptySessionDraft)
  })

  it("forgets a draft once its message is sent", () => {
    const store = createSessionDraftStore()
    store.write("s1", { ...emptySessionDraft, prompt: "sent" })
    store.clear("s1")
    expect(store.read("s1")).toEqual(emptySessionDraft)
  })

  it("drops an empty draft rather than holding a row for it", () => {
    const store = createSessionDraftStore()
    store.write("s1", { ...emptySessionDraft, prompt: "typed" })
    store.write("s1", emptySessionDraft)
    expect(store.size()).toBe(0)
  })

  it("drops every draft at once, for a workspace that is torn down", () => {
    const store = createSessionDraftStore()
    store.write("s1", { ...emptySessionDraft, prompt: "one" })
    store.write("s2", { ...emptySessionDraft, prompt: "two" })
    store.clearAll()
    expect(store.size()).toBe(0)
  })

  it("holds a bounded number of sessions, dropping the least recently written", () => {
    const store = createSessionDraftStore(3)
    store.write("s1", { ...emptySessionDraft, prompt: "one" })
    store.write("s2", { ...emptySessionDraft, prompt: "two" })
    store.write("s3", { ...emptySessionDraft, prompt: "three" })
    store.write("s4", { ...emptySessionDraft, prompt: "four" })
    expect(store.size()).toBe(3)
    expect(store.read("s1")).toEqual(emptySessionDraft)
    expect(store.read("s4").prompt).toBe("four")
  })

  it("counts a rewrite as recent, so it is not the one dropped", () => {
    const store = createSessionDraftStore(2)
    store.write("s1", { ...emptySessionDraft, prompt: "one" })
    store.write("s2", { ...emptySessionDraft, prompt: "two" })
    store.write("s1", { ...emptySessionDraft, prompt: "one again" })
    store.write("s3", { ...emptySessionDraft, prompt: "three" })
    expect(store.read("s1").prompt).toBe("one again")
    expect(store.read("s2")).toEqual(emptySessionDraft)
  })

  it("bounds the default store, so a long session list cannot grow it without end", () => {
    expect(maximumRetainedSessionDrafts).toBeGreaterThan(0)
    expect(maximumRetainedSessionDrafts).toBeLessThanOrEqual(50)
  })
})
