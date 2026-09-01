import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { SqliteTransferReceipts, maximumListedTransferReceipts } from "./transfer-receipts.js"

const receipt = {
  sessionId: "session-1",
  sourceMachineId: `machine-${"a".repeat(32)}`,
  targetMachineId: `machine-${"b".repeat(32)}`,
  method: "git-bundle" as const,
  checkpointId: "checkpoint-1",
  checkpointCommit: "c".repeat(40),
  recoveryCheckpointRetained: true as const,
  outcome: "succeeded" as const,
  decidedBy: { client: "desktop" as const },
  startedAt: "2026-09-01T09:00:00.000Z",
  completedAt: "2026-09-01T09:00:20.000Z",
}

function receipts() {
  return new SqliteTransferReceipts(new DatabaseSync(":memory:"))
}

describe("SqliteTransferReceipts", () => {
  it("keeps a receipt for a transfer that happened", () => {
    const store = receipts()

    store.record(receipt)

    expect(store.list()).toEqual([receipt])
  })

  it("keeps a receipt for a transfer that was refused", () => {
    const store = receipts()
    const refused = { ...receipt, outcome: "refused" as const, reason: "target-unreachable" as const }

    store.record(refused)

    expect(store.list()).toEqual([refused])
  })

  it("lists the most recent transfers first", () => {
    const store = receipts()
    store.record(receipt)
    store.record({ ...receipt, sessionId: "session-2", completedAt: "2026-09-01T09:05:00.000Z" })

    expect(store.list().map((entry) => entry.sessionId)).toEqual(["session-2", "session-1"])
  })

  it("bounds what a caller can ask for", () => {
    const store = receipts()
    for (let index = 0; index < 5; index += 1) {
      store.record({ ...receipt, sessionId: `session-${index}` })
    }

    expect(store.list({ limit: 2 })).toHaveLength(2)
    expect(store.list({ limit: maximumListedTransferReceipts + 100 }).length)
      .toBeLessThanOrEqual(maximumListedTransferReceipts)
  })

  it("refuses a receipt that claims the source kept no recovery checkpoint", () => {
    const store = receipts()

    // The source always keeps its recovery checkpoint, so a receipt cannot say
    // otherwise and still be recorded.
    expect(() => store.record({ ...receipt, recoveryCheckpointRetained: false } as never))
      .toThrow("Transfer receipt is invalid")
    expect(store.list()).toEqual([])
  })
})
