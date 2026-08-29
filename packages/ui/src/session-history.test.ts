import { describe, expect, it } from "vitest"

import type { SessionHistoryEntry, SessionHistoryPage } from "@getdomovoi/protocol"

import {
  mergeOlderHistory,
  sessionHistoryCategories,
  sessionHistoryEntryDetail,
  sessionHistoryEntryTitle,
} from "./session-history"

const message = (id: string): SessionHistoryEntry => ({
  id: `thread:${id}`,
  sourceId: id,
  sessionId: "session-one",
  category: "messages",
  role: "user",
  body: id,
  createdAt: "2026-08-28T12:00:00.000Z",
})

describe("session history view model", () => {
  it("exposes every semantic filter in roadmap order", () => {
    expect(sessionHistoryCategories.map(({ value }) => value)).toEqual([
      "messages",
      "tools",
      "approvals",
      "handoffs",
      "checkpoints",
      "annotations",
      "tests",
    ])
  })

  it("prepends older pages without duplicating an overlapping cursor item", () => {
    const current: SessionHistoryPage = {
      sessionId: "session-one",
      items: [message("two"), message("three")],
      hasMore: true,
      nextCursor: "thread:two",
    }
    const older: SessionHistoryPage = {
      sessionId: "session-one",
      items: [message("one"), message("two")],
      hasMore: false,
    }

    expect(mergeOlderHistory(current, older)).toMatchObject({
      items: [message("one"), message("two"), message("three")],
      hasMore: false,
    })
  })

  it("formats typed entries without discarding recorded detail", () => {
    const testEntry: SessionHistoryEntry = {
      id: "thread:test-one",
      sourceId: "test-one",
      sessionId: "session-one",
      category: "tests",
      tool: "command",
      status: "failed",
      title: "pnpm test",
      output: "one failed",
      createdAt: "2026-08-28T12:00:00.000Z",
    }

    expect(sessionHistoryEntryTitle(testEntry)).toBe("pnpm test")
    expect(sessionHistoryEntryDetail(testEntry)).toBe("one failed")
  })
})
