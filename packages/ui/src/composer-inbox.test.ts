import { describe, expect, it, vi } from "vitest"

import type { SessionAttachment } from "@getdomovoi/protocol"

import { createComposerInbox } from "./composer-inbox"

const output = (content: string): SessionAttachment => ({
  kind: "text",
  name: "terminal-output.txt",
  mimeType: "text/plain",
  content,
})

describe("composer inbox", () => {
  it("delivers to the composer open for that session and no other", () => {
    const inbox = createComposerInbox()
    const billing = vi.fn(() => "attached" as const)
    const search = vi.fn(() => "attached" as const)
    inbox.open("session-billing", billing)
    inbox.open("session-search", search)

    expect(inbox.offer("session-billing", output("$ pnpm test"))).toBe("attached")

    expect(billing).toHaveBeenCalledWith(output("$ pnpm test"))
    expect(search).not.toHaveBeenCalled()
  })

  // An attach is for the session whose terminal printed it. When that
  // session's composer is not open it is dropped, never held for later and
  // never handed to whichever composer is open, so it cannot land in another
  // session's draft.
  it("drops an offer for a session whose composer is not open", () => {
    const inbox = createComposerInbox()
    const search = vi.fn(() => "attached" as const)
    inbox.open("session-search", search)

    expect(inbox.offer("session-billing", output("secret-free output"))).toBe("closed")
    expect(search).not.toHaveBeenCalled()

    const billing = vi.fn(() => "attached" as const)
    inbox.open("session-billing", billing)
    expect(billing).not.toHaveBeenCalled()
  })

  it("stops delivering once the composer closes", () => {
    const inbox = createComposerInbox()
    const billing = vi.fn(() => "attached" as const)
    const close = inbox.open("session-billing", billing)

    expect(inbox.canReceive("session-billing")).toBe(true)
    close()

    expect(inbox.canReceive("session-billing")).toBe(false)
    expect(inbox.offer("session-billing", output("late"))).toBe("closed")
    expect(billing).not.toHaveBeenCalled()
  })

  // A remount opens the new composer before the old one's cleanup runs. The
  // stale close must not take the new composer's place with it.
  it("keeps a newer composer when an older one for the same session closes", () => {
    const inbox = createComposerInbox()
    const older = inbox.open("session-billing", () => "attached")
    const newer = vi.fn(() => "attached" as const)
    inbox.open("session-billing", newer)
    older()

    expect(inbox.offer("session-billing", output("kept"))).toBe("attached")
    expect(newer).toHaveBeenCalledTimes(1)
  })

  it("reports a full composer", () => {
    const inbox = createComposerInbox()
    inbox.open("session-billing", () => "full")

    expect(inbox.offer("session-billing", output("one too many"))).toBe("full")
  })

  it("tells subscribers when a composer opens or closes", () => {
    const inbox = createComposerInbox()
    const listener = vi.fn()
    const unsubscribe = inbox.subscribe(listener)

    const close = inbox.open("session-billing", () => "attached")
    close()
    unsubscribe()
    inbox.open("session-billing", () => "attached")

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("never receives for no session", () => {
    expect(createComposerInbox().canReceive(null)).toBe(false)
  })
})
