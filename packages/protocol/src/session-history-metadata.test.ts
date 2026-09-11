import { describe, expect, it } from "vitest"

import { sessionHistoryEntrySchema, sessionHistoryParamsSchema } from "./rpc.js"
import { protocolVersion, threadItemSchema } from "./schema.js"
import { protocolCompatibility } from "./fleet-health.js"

const receipt = {
  id: "receipt-one",
  sessionId: "session-one",
  kind: "receipt",
  decision: "allow-once",
  operation: "Run tests",
  checkpoint: "checkpoint-one",
  client: "desktop",
  createdAt: "2026-09-10T12:00:38.000Z",
}

const approval = {
  ...receipt,
  id: "thread:receipt-one",
  sourceId: receipt.id,
  category: "approvals",
}

const transfer = {
  transferId: `transfer-${"a".repeat(32)}`,
  sourceMachineId: `machine-${"b".repeat(32)}`,
  targetMachineId: `machine-${"c".repeat(32)}`,
  checkpointCommit: "d".repeat(40),
  outcome: "succeeded",
  preflight: "passed",
  coverage: {
    included: [{ kind: "repository", count: 1 }],
    excluded: [{ kind: "ignored-files", count: 3 }],
    warnings: [],
  },
}
const departure = {
  id: "system-transfer-one",
  sessionId: "session-one",
  kind: "system",
  body: "Transferred to another machine.",
  createdAt: "2026-09-10T12:00:38.000Z",
  transfer,
}

describe("session history metadata", () => {
  it("requires clients that understand the transfers history variant", () => {
    expect(protocolCompatibility(protocolVersion, "0.5.0")).toBe("machine-ahead")
  })

  it("retains decision latency on receipts and approval history without requiring it on older data", () => {
    for (const [schema, value] of [
      [threadItemSchema, receipt],
      [sessionHistoryEntrySchema, approval],
    ] as const) {
      expect(schema.parse(value)).not.toHaveProperty("decisionDurationMs")
      expect(schema.parse({ ...value, decisionDurationMs: 38_000 }))
        .toHaveProperty("decisionDurationMs", 38_000)
      expect(schema.parse({ ...value, decisionDurationMs: 0 }))
        .toHaveProperty("decisionDurationMs", 0)
      for (const duration of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "38000"]) {
        expect(schema.safeParse({ ...value, decisionDurationMs: duration }).success).toBe(false)
      }
    }
  })

  it("carries a committed machine transfer through durable thread and history validation", () => {
    expect(threadItemSchema.parse(departure)).toEqual(departure)
    const entry = {
      id: `thread:${departure.id}`,
      sourceId: departure.id,
      sessionId: departure.sessionId,
      category: "transfers",
      body: departure.body,
      createdAt: departure.createdAt,
      transfer,
    }
    expect(sessionHistoryEntrySchema.parse(entry)).toEqual(entry)
    expect(sessionHistoryParamsSchema.parse({ sessionId: entry.sessionId, categories: ["transfers"] }))
      .toMatchObject({ categories: ["transfers"] })
    for (const malformed of [
      { ...transfer, transferId: "invented" },
      { ...transfer, targetMachineId: transfer.sourceMachineId },
      { ...transfer, preflight: "failed" },
      { ...transfer, outcome: "refused" },
      { ...transfer, coverage: { ...transfer.coverage, excluded: [{ kind: "ignored-files", count: -1 }] } },
    ]) {
      expect(threadItemSchema.safeParse({ ...departure, transfer: malformed }).success).toBe(false)
      expect(sessionHistoryEntrySchema.safeParse({ ...entry, transfer: malformed }).success).toBe(false)
    }
  })

  it("keeps missing holdback measurements unknown", () => {
    const unknownCount = {
      ...transfer,
      coverage: { ...transfer.coverage, excluded: [{ kind: "ignored-files" }] },
    }
    expect(threadItemSchema.parse({ ...departure, transfer: unknownCount }))
      .toHaveProperty("transfer.coverage.excluded", [{ kind: "ignored-files" }])
    const { coverage: _coverage, ...legacyTransfer } = transfer
    expect(threadItemSchema.parse({ ...departure, transfer: legacyTransfer }))
      .toHaveProperty("transfer", legacyTransfer)
  })
})
