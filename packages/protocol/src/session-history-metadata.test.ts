import { describe, expect, it } from "vitest"

import { maximumPairedDeviceLabelLength } from "./devices.js"
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

  // Ruling Q424 A: the receipt names the paired device that decided, in the
  // shape a terminal owner names it, so a client draws "allowed once by
  // <label> · <client>" from the wire. A root bearer has no device, so the
  // field is absent; a snapshot written before the field existed parses.
  it("carries the deciding device on receipts and approval history, bounded like a paired device label", () => {
    const device = { id: `device-${"a".repeat(32)}`, label: "dana" }
    for (const [schema, value] of [
      [threadItemSchema, receipt],
      [sessionHistoryEntrySchema, approval],
    ] as const) {
      expect(schema.parse(value)).not.toHaveProperty("device")
      expect(schema.parse({ ...value, device })).toHaveProperty("device", device)
      expect(schema.parse({ ...value, device: { ...device, label: "  dana  " } })).toHaveProperty("device", device)
      for (const malformed of [
        { label: "dana" },
        { id: device.id },
        { id: "device-1", label: "dana" },
        { ...device, label: "" },
        { ...device, label: "   " },
        { ...device, label: "n".repeat(maximumPairedDeviceLabelLength + 1) },
        { ...device, clientId: "extra" },
        "dana",
      ]) {
        expect(schema.safeParse({ ...value, device: malformed }).success, JSON.stringify(malformed)).toBe(false)
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
