import { describe, expect, it, vi } from "vitest"

import {
  DesktopDeepLinkQueue,
  deepLinksFromArgv,
  parseDomovoiDeepLink,
} from "./deep-links.js"

describe("parseDomovoiDeepLink", () => {
  it("accepts only bounded session routes", () => {
    expect(parseDomovoiDeepLink("domovoi://session/session-billing_2")).toEqual({
      kind: "session",
      sessionId: "session-billing_2",
    })
    expect(parseDomovoiDeepLink(`domovoi://session/${"a".repeat(128)}`)?.sessionId).toHaveLength(128)
  })

  it.each([
    "https://session/session-billing",
    "domovoi://project/session-billing",
    "domovoi://session/",
    "domovoi://session/../private",
    "domovoi://session/session-billing/extra",
    "domovoi://user:secret@session/session-billing",
    "domovoi://session/session-billing?token=secret",
    "domovoi://session/session-billing#fragment",
    `domovoi://session/${"a".repeat(129)}`,
    "domovoi://session/session%2Fbilling",
    "not a URL",
  ])("rejects an invalid or over-capable link: %s", (value) => {
    expect(parseDomovoiDeepLink(value)).toBeNull()
  })

  it("extracts protocol URLs from Windows and Linux second-instance argv", () => {
    expect(deepLinksFromArgv([
      "/opt/Domovoi/domovoi",
      "--flag",
      "domovoi://session/session-one",
      "domovoi://session/session-two",
      "https://attacker.invalid",
    ])).toEqual([
      { kind: "session", sessionId: "session-one" },
      { kind: "session", sessionId: "session-two" },
    ])
  })
})

describe("DesktopDeepLinkQueue", () => {
  it("queues before renderer readiness, deduplicates, and routes in order", () => {
    const queue = new DesktopDeepLinkQueue(3)
    queue.enqueue({ kind: "session", sessionId: "session-one" })
    queue.enqueue({ kind: "session", sessionId: "session-one" })
    queue.enqueue({ kind: "session", sessionId: "session-two" })
    const route = vi.fn()

    queue.ready(route)

    expect(route.mock.calls.map(([link]) => link.sessionId)).toEqual(["session-one", "session-two"])
    queue.enqueue({ kind: "session", sessionId: "session-three" })
    expect(route).toHaveBeenLastCalledWith({ kind: "session", sessionId: "session-three" })
  })

  it("stays bounded and resumes routing after the renderer pauses", () => {
    const queue = new DesktopDeepLinkQueue(2)
    queue.enqueue({ kind: "session", sessionId: "session-one" })
    queue.enqueue({ kind: "session", sessionId: "session-two" })
    queue.enqueue({ kind: "session", sessionId: "session-three" })
    const first = vi.fn()
    queue.ready(first)
    expect(first.mock.calls.map(([link]) => link.sessionId)).toEqual(["session-two", "session-three"])

    queue.pause(first)
    queue.enqueue({ kind: "session", sessionId: "session-four" })
    expect(first).toHaveBeenCalledTimes(2)
    const second = vi.fn()
    queue.ready(second)
    expect(second).toHaveBeenCalledWith({ kind: "session", sessionId: "session-four" })
  })
})
