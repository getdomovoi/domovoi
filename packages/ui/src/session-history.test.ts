import { afterEach, describe, expect, it, vi } from "vitest"

import type { SessionHistoryEntry, SessionHistoryPage } from "@getdomovoi/protocol"

import {
  latestSessionHistoryRequest,
  SessionHistoryRequestController,
  sessionHistorySearchDebounceMs,
  historyWindowedAfterMerge,
  maximumRetainedSessionHistoryItems,
  mergeOlderHistory,
  resetSessionHistoryWindow,
  sessionHistoryCategories,
  sessionHistoryEntryDetail,
  sessionHistoryEntryTitle,
} from "./session-history"

afterEach(() => {
  vi.useRealTimers()
})

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

  it("keeps a truncated history window marked after an overlap-only page", () => {
    const current: SessionHistoryPage = {
      sessionId: "session-one",
      items: Array.from(
        { length: maximumRetainedSessionHistoryItems },
        (_, index) => message(String(index)),
      ),
      hasMore: true,
      nextCursor: "thread:0",
    }
    const overlapping: SessionHistoryPage = {
      sessionId: "session-one",
      items: current.items.slice(0, 50),
      hasMore: false,
    }

    expect(historyWindowedAfterMerge(true, current, overlapping)).toBe(true)
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

  it("debounces search by the exact delay and aborts a stale request", async () => {
    vi.useFakeTimers()
    const loads: Array<{ query: string; signal: AbortSignal }> = []
    const completions: string[] = []
    const controller = new SessionHistoryRequestController<string>()

    controller.schedule({
      debounce: true,
      load: (signal) => {
        loads.push({ query: "a", signal })
        return new Promise(() => undefined)
      },
      onSuccess: (value) => completions.push(value),
    })
    await vi.advanceTimersByTimeAsync(sessionHistorySearchDebounceMs - 1)
    expect(loads).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(loads).toHaveLength(1)

    controller.schedule({
      debounce: true,
      load: async (signal) => {
        loads.push({ query: "ab", signal })
        return "new"
      },
      onSuccess: (value) => completions.push(value),
    })
    expect(loads[0]?.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(sessionHistorySearchDebounceMs)
    await Promise.resolve()
    expect(loads.map(({ query }) => query)).toEqual(["a", "ab"])
    expect(completions).toEqual(["new"])
  })

  it("starts session/filter changes immediately and suppresses stale completion", async () => {
    const pending: Array<{ resolve: (value: string) => void; signal: AbortSignal }> = []
    const completions: string[] = []
    const controller = new SessionHistoryRequestController<string>()
    const schedule = () => controller.schedule({
      debounce: false,
      load: (signal) => new Promise<string>((resolve) => pending.push({ resolve, signal })),
      onSuccess: (value) => completions.push(value),
    })

    schedule()
    schedule()
    expect(pending[0]?.signal.aborted).toBe(true)
    pending[0]!.resolve("stale")
    pending[1]!.resolve("current")
    await Promise.resolve()
    await Promise.resolve()
    expect(completions).toEqual(["current"])
  })

  it("cancels timers and active work during cleanup", async () => {
    vi.useFakeTimers()
    const load = vi.fn((_signal: AbortSignal) => new Promise<string>(() => undefined))
    const controller = new SessionHistoryRequestController<string>()
    controller.schedule({ debounce: true, load, onSuccess: vi.fn() })
    controller.dispose()
    await vi.runAllTimersAsync()
    expect(load).not.toHaveBeenCalled()

    controller.schedule({ debounce: false, load, onSuccess: vi.fn() })
    const signal = load.mock.calls[0]![0]
    controller.dispose()
    expect(signal.aborted).toBe(true)
  })
})
