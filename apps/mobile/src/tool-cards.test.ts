import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { threadEntries } from "./session-detail"
import { foldsAway, parseToolCardDefault, toolCardOpen, toolSummary } from "./tool-cards"

describe("parseToolCardDefault", () => {
  it("reads the two stored choices and starts collapsed otherwise", () => {
    expect(parseToolCardDefault("expanded")).toBe("expanded")
    expect(parseToolCardDefault("collapsed")).toBe("collapsed")
    expect(parseToolCardDefault(null)).toBe("collapsed")
    expect(parseToolCardDefault("open")).toBe("collapsed")
  })
})

describe("toolSummary", () => {
  it("joins a many-line command onto one line", () => {
    expect(toolSummary("sed -n '1,4p' a.md\n  && cat b.md\n")).toBe("sed -n '1,4p' a.md && cat b.md")
  })

  it("bounds a very long command so one line is cheap to lay out", () => {
    const summary = toolSummary("x".repeat(10_000))
    expect(summary.length).toBeLessThanOrEqual(241)
    expect(summary.endsWith("…")).toBe(true)
  })
})

describe("toolCardOpen", () => {
  it("follows a hand choice over the default", () => {
    expect(toolCardOpen(undefined, "collapsed")).toBe(false)
    expect(toolCardOpen(undefined, "expanded")).toBe(true)
    expect(toolCardOpen(true, "collapsed")).toBe(true)
    expect(toolCardOpen(false, "expanded")).toBe(false)
  })
})

describe("foldsAway", () => {
  function tool(status: "running" | "completed" | "failed" | "declined") {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.thread = [{
      id: "tool", sessionId: "session-billing", kind: "tool", tool: "command", status, title: "pnpm migrate", createdAt: "2026-08-25T21:52:00.000Z",
    }]
    const entry = threadEntries(snapshot, "session-billing").entries[0]
    if (!entry) throw new Error("fixture needs a tool entry")
    return entry
  }

  it("names the tool and its status on the entry", () => {
    expect(tool("failed")).toMatchObject({ kind: "note", tool: { name: "command", status: "failed" } })
  })

  it("folds a tool call", () => {
    expect(foldsAway(tool("completed"), false)).toBe(true)
    expect(foldsAway(tool("running"), false)).toBe(true)
  })

  // A gate's item id is the provider's, not the thread row's, so the phone
  // cannot tell which running call a waiting approval holds. Every running
  // call stays open while one waits, which can show more but never less.
  it("never folds a running call while an approval waits", () => {
    expect(foldsAway(tool("running"), true)).toBe(false)
    expect(foldsAway(tool("completed"), true)).toBe(true)
    expect(foldsAway(tool("declined"), true)).toBe(true)
  })

  it("never folds anything that is not a tool call", () => {
    const snapshot = structuredClone(demoWorkspace)
    for (const entry of threadEntries(snapshot, "session-billing").entries) {
      expect(foldsAway(entry, false)).toBe(false)
    }
  })
})
