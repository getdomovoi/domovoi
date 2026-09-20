import { afterEach, describe, expect, it, vi } from "vitest"

import type { SessionHistoryEntry, SessionHistoryPage } from "@getdomovoi/protocol"
import { sessionHistoryCategorySchema } from "@getdomovoi/protocol"

import {
  latestSessionHistoryRequest,
  sessionHistoryEntryBody,
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
  // The drawn filters lead and carry the design's words. Handoffs is not one of
  // them and is not Transfers either: it holds provider handoffs, so it keeps
  // its own word and sits at the tail with the other undrawn filters.
  it("leads with the drawn filters and keeps Handoffs its own word", () => {
    expect(sessionHistoryCategories).toEqual([
      { value: "messages", label: "Turns" },
      { value: "approvals", label: "Approvals" },
      { value: "policy-refusals", label: "Policy refusals" },
      { value: "checkpoints", label: "Checkpoints" },
      { value: "transfers", label: "Transfers" },
      { value: "handoffs", label: "Handoffs" },
      { value: "tools", label: "Tools" },
      { value: "annotations", label: "Annotations" },
      { value: "tests", label: "Tests" },
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

  it("renders a machine transfer as a transfer rather than an annotation", () => {
    const entry: SessionHistoryEntry = {
      id: "thread:transfer-note",
      sourceId: "transfer-note",
      sessionId: "session-one",
      category: "transfers",
      body: "Transferred to another machine.",
      detail: "The source keeps a recovery checkpoint.",
      createdAt: "2026-09-10T12:00:00.000Z",
      transfer: {
        transferId: `transfer-${"a".repeat(32)}`,
        sourceMachineId: `machine-${"b".repeat(32)}`,
        targetMachineId: `machine-${"c".repeat(32)}`,
        checkpointCommit: "d".repeat(40),
        outcome: "succeeded",
        preflight: "passed",
      },
    }
    expect(sessionHistoryEntryTitle(entry)).toBe("Transferred to another machine.")
    expect(sessionHistoryEntryDetail(entry)).toBe("The source keeps a recovery checkpoint.")
    delete entry.detail
    entry.transfer.coverage = { included: [], excluded: [{ kind: "ignored-files", count: 3 }], warnings: [] }
    const detail = sessionHistoryEntryDetail(entry)
    expect(detail).toContain(entry.transfer.sourceMachineId)
    expect(detail).toContain(entry.transfer.targetMachineId)
    expect(detail).toContain(entry.transfer.checkpointCommit)
    expect(detail).toContain("preflight passed")
    expect(detail).toContain("3 ignored files held back")
    delete entry.transfer.coverage
    expect(sessionHistoryEntryDetail(entry)).not.toContain("0 ignored files")
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
    // The meta is the row's one line; the output it recorded is not discarded,
    // it moves to the row's expanded state.
    expect(sessionHistoryEntryDetail(testEntry)).toBe("command · failed")
    expect(sessionHistoryEntryBody(testEntry)).toBe("one failed")
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

// A filter list shorter than the enum is not a smaller list, it is a hole:
// latestSessionHistoryRequest sends the selected categories, so a category with
// no control never reaches the daemon and its rows never load.
describe("session history filters against the wire", () => {
  it("offers a filter for every category the daemon can stamp", () => {
    expect(sessionHistoryCategories.map(({ value }) => value).toSorted())
      .toEqual([...sessionHistoryCategorySchema.options].toSorted())
  })
})
