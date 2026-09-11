import type { SessionHistoryEntry } from "@getdomovoi/protocol"
import { sessionHistoryCategorySchema } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  sessionHistoryCategories,
  sessionHistoryEntryDetail,
  sessionHistoryEntryTitle,
} from "./session-history"

const transfer = (over: Record<string, unknown> = {}) => ({
  id: "thread:one",
  sourceId: "one",
  sessionId: "session-billing",
  createdAt: "2026-09-10T13:58:00.000Z",
  category: "transfers",
  body: "Moved here from wsl-ubuntu-24",
  transfer: {
    transferId: "transfer-1",
    sourceMachineId: "wsl-ubuntu-24",
    targetMachineId: "mac-mini-m4",
    checkpointCommit: "8f3c1de",
    outcome: "succeeded",
    preflight: "passed",
  },
  ...over,
} as unknown as SessionHistoryEntry)

// A machine transfer and a provider handoff are different events. The protocol
// gained the transfers category; this client only knew handoffs, so
// entry.action was reached on a transfer and the build stopped. It is named
// here rather than absorbed by a default.
describe("a machine transfer in session history", () => {
  it("titles a transfer rather than falling through to an annotation", () => {
    expect(sessionHistoryEntryTitle(transfer())).toBe("Moved here from wsl-ubuntu-24")
  })

  it("says where it went and what it carried when no detail was written", () => {
    expect(sessionHistoryEntryDetail(transfer()))
      .toBe("wsl-ubuntu-24 to mac-mini-m4 · checkpoint 8f3c1de · preflight passed")
  })

  it("prefers a detail the daemon wrote", () => {
    expect(sessionHistoryEntryDetail(transfer({ detail: "3 unversioned files held back" })))
      .toBe("3 unversioned files held back")
  })
})

// A filter list shorter than the enum is not a smaller list, it is a hole: the
// selected categories are what the query asks for, so a category with no
// control never reaches the daemon and its rows never load. That is how
// reclassified machine transfers would have been hidden from a default query.
describe("session history filters against the wire", () => {
  it("offers a filter for every category the daemon can stamp", () => {
    expect(sessionHistoryCategories.map(({ value }) => value).toSorted())
      .toEqual([...sessionHistoryCategorySchema.options].toSorted())
  })
})
