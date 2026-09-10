import type { SessionHistoryEntry } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { sessionHistoryEntryOutcome } from "./session-history"

const base = {
  id: "thread:one",
  sourceId: "one",
  sessionId: "session-billing",
  createdAt: "2026-09-08T12:51:00.000Z",
}

// The row draws a dot, and the atom's rule is that colour never carries the
// meaning alone. So every row has to be able to say its outcome in a word, and
// that word has to come from the entry rather than from a guess.
describe("session history entry outcome", () => {
  it("reads a tool row from its status", () => {
    for (const [status, meaning, label] of [
      ["running", "idle", "running"],
      ["completed", "online", "completed"],
      ["failed", "offline", "failed"],
      ["declined", "waiting", "declined"],
    ] as const) {
      expect(sessionHistoryEntryOutcome({
        ...base,
        category: "tools",
        tool: "command",
        status,
        title: "pnpm test",
      } as SessionHistoryEntry)).toEqual({ meaning, label })
    }
  })

  it("reads an approval row from its decision", () => {
    for (const [decision, meaning] of [
      ["allow-once", "online"],
      ["always-project", "online"],
      ["deny", "offline"],
      ["deny-explain", "offline"],
    ] as const) {
      expect(sessionHistoryEntryOutcome({
        ...base,
        category: "approvals",
        decision,
        operation: "write",
        checkpoint: "7f23",
        client: "desktop",
      } as SessionHistoryEntry)).toEqual({ meaning, label: decision })
    }
  })

  // A checkpoint that exists is not an outcome. It gets the neutral dot and a
  // word that says so, rather than borrowing green from a row that succeeded.
  it("gives a row with no outcome of its own the neutral dot", () => {
    expect(sessionHistoryEntryOutcome({
      ...base,
      category: "checkpoints",
      label: "7f23 · before migration",
    } as SessionHistoryEntry)).toEqual({ meaning: "idle", label: "recorded" })
  })
})
