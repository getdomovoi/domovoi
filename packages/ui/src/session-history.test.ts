import { describe, expect, it } from "vitest"

import type { SessionHistoryEntry, SessionHistoryPage } from "@getdomovoi/protocol"

import {
  latestSessionHistoryRequest,
  maximumRetainedSessionHistoryItems,
  mergeOlderHistory,
  resetSessionHistoryWindow,
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

  it("moves a bounded window backward through sequential older pages", () => {
    let current: SessionHistoryPage = {
      sessionId: "session-one",
      items: Array.from({ length: 50 }, (_, index) => message(String(index + 250))),
      hasMore: true,
      nextCursor: "thread:250",
    }

    const loadOlderPage = (start: number, hasMore: boolean) => {
      current = mergeOlderHistory(current, {
        sessionId: "session-one",
        items: Array.from({ length: 50 }, (_, index) => message(String(start + index))),
        hasMore,
        ...(hasMore ? { nextCursor: `thread:${start}` } : {}),
      })
    }

    loadOlderPage(200, true)
    loadOlderPage(150, true)
    loadOlderPage(100, true)
    expect(current.items.map((item) => item.sourceId)).toEqual(
      Array.from({ length: 200 }, (_, index) => String(index + 100)),
    )

    loadOlderPage(50, true)
    expect(current.items).toHaveLength(maximumRetainedSessionHistoryItems)
    expect(current.items[0]?.sourceId).toBe("50")
    expect(current.items.at(-1)?.sourceId).toBe("249")
    expect(current).toMatchObject({ hasMore: true, nextCursor: "thread:50" })

    loadOlderPage(0, false)
    expect(current.items).toHaveLength(maximumRetainedSessionHistoryItems)
    expect(current.items[0]?.sourceId).toBe("0")
    expect(current.items.at(-1)?.sourceId).toBe("199")
    expect(current.hasMore).toBe(false)
    expect(current.nextCursor).toBeUndefined()
  })

  it("resets an older window before reloading the latest page", () => {
    const reset = resetSessionHistoryWindow({
      page: {
        sessionId: "session-one",
        items: Array.from({ length: 200 }, (_, index) => message(String(index))),
        hasMore: false,
      },
      historyWindowed: true,
      historyRefresh: 4,
    })

    expect(reset).toEqual({
      page: undefined,
      historyWindowed: false,
      historyRefresh: 5,
    })
    expect(latestSessionHistoryRequest(["messages"], " durable history ")).toEqual({
      categories: ["messages"],
      query: "durable history",
      limit: 50,
    })
    expect(latestSessionHistoryRequest(["messages"], "")).not.toHaveProperty("before")
  })
})
