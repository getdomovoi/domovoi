import type { SessionHistoryEntry } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { sessionHistoryEntryBody, sessionHistoryEntryDetail, sessionHistoryEntryTitle } from "./session-history"

const base = {
  id: "thread:one",
  sourceId: "one",
  sessionId: "session-billing",
  createdAt: "2026-09-08T12:51:00.000Z",
}

const entry = (rest: object) => ({ ...base, ...rest }) as SessionHistoryEntry

// A row says what happened in one line. The content it happened to produce is
// still reachable, it just stops being the row.
describe("what a row says and what it holds", () => {
  it("puts the message prose in the title and keeps the whole body reachable", () => {
    const message = entry({
      category: "messages",
      role: "assistant",
      body: "Migrating the billing webhooks now.\nStarting with the retry path.",
    })

    expect(sessionHistoryEntryTitle(message)).toBe("Migrating the billing webhooks now.")
    expect(sessionHistoryEntryDetail(message)).toBe("assistant")
    expect(sessionHistoryEntryBody(message)).toBe(
      "Migrating the billing webhooks now.\nStarting with the retry path.",
    )
  })

  it("keeps tool output out of the row and reachable underneath it", () => {
    const tool = entry({
      category: "tools",
      tool: "command",
      status: "failed",
      title: "pnpm test",
      output: "1 failing\nsecond line",
    })

    expect(sessionHistoryEntryDetail(tool)).toBe("command · failed")
    expect(sessionHistoryEntryBody(tool)).toBe("1 failing\nsecond line")
  })

  // Two identifiers doing two jobs: the title names the checkpoint, the meta
  // names the commit. The daemon writes the sha into the label at all seven of
  // its checkpoint sites, so the title has to drop it.
  it("names the checkpoint in the title and the commit in the meta", () => {
    const checkpoint = entry({
      category: "checkpoints",
      label: "8f3c1de5 · before migration",
      commit: "8f3c1de5" + "0".repeat(32),
    })

    expect(sessionHistoryEntryTitle(checkpoint)).toBe("Checkpoint: before migration")
    expect(sessionHistoryEntryDetail(checkpoint, { worktreeName: "wt-billing-idem" }))
      .toBe("commit 8f3c1de5 · worktree wt-billing-idem")
    expect(sessionHistoryEntryBody(checkpoint)).toBeUndefined()
  })

  it("leaves a label alone when its prefix is not this checkpoint's commit", () => {
    const checkpoint = entry({
      category: "checkpoints",
      label: "before migration",
      commit: "8f3c1de5" + "0".repeat(32),
    })

    expect(sessionHistoryEntryTitle(checkpoint)).toBe("Checkpoint: before migration")
    expect(sessionHistoryEntryDetail(checkpoint)).toBe("commit 8f3c1de5")
  })

  // decisionDurationMs measures how long the decision took, not how long the
  // approved operation ran. The copy has to say which.
  it("says an approval was decided in, not that it ran", () => {
    const approval = entry({
      category: "approvals",
      decision: "allow-once",
      operation: "write",
      checkpoint: "7f23",
      client: "desktop",
      decisionDurationMs: 38_000,
    })

    expect(sessionHistoryEntryDetail(approval)).toContain("decided on desktop")
    expect(sessionHistoryEntryDetail(approval)).toContain("decided in 38s")
    expect(sessionHistoryEntryDetail(approval)).not.toContain("ran 38s")
  })

  it("says nothing about duration when the daemon did not measure one", () => {
    const approval = entry({
      category: "approvals",
      decision: "deny",
      operation: "write",
      checkpoint: "7f23",
      client: "desktop",
    })

    expect(sessionHistoryEntryDetail(approval)).not.toContain("decided in")
  })
})
