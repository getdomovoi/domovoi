import { describe, expect, it } from "vitest"
import { approvalRequestSchema, sessionSummarySchema, threadItemSchema } from "./schema.js"
import { sessionHistoryEntrySchema } from "./rpc.js"

const checkpoint = { id: "checkpoint", sessionId: "session", kind: "checkpoint", label: "Words a person chose", commit: "a".repeat(40), createdAt: "2026-09-10T12:00:00.000Z" }
const history = { id: "thread:checkpoint", sourceId: checkpoint.id, sessionId: checkpoint.sessionId, category: "checkpoints", label: checkpoint.label, commit: checkpoint.commit, createdAt: checkpoint.createdAt }

describe("checkpoint reasons", () => {
  it.each(["session-start", "fork", "manual", "before-restore", "before-revert", "before-provider-handoff", "before-provider-recovery", "before-archive", "before-approved-command"])("preserves %s independently of the label and commit", (reason) => {
    expect(threadItemSchema.parse({ ...checkpoint, reason })).toEqual({ ...checkpoint, reason })
    expect(sessionHistoryEntrySchema.parse({ ...history, reason })).toEqual({ ...history, reason })
  })

  it("keeps legacy checkpoints unknown even when their label says session start", () => {
    expect(threadItemSchema.parse({ ...checkpoint, label: "session start" })).not.toHaveProperty("reason")
    expect(sessionHistoryEntrySchema.parse({ ...history, label: "session start" })).not.toHaveProperty("reason")
  })

  it.each(["", "session start", "invented", 1])("rejects invalid reason %s", (reason) => {
    expect(threadItemSchema.safeParse({ ...checkpoint, reason }).success).toBe(false)
    expect(sessionHistoryEntrySchema.safeParse({ ...history, reason }).success).toBe(false)
  })

  it("carries how long an approved command ran, on the receipt and its history entry", () => {
    // J34: "Checkpoint ckpt_7f24 was taken first, then it ran in 38s."
    const receipt = {
      id: "receipt", sessionId: "session", kind: "receipt", decision: "allow-once", operation: "Run migrations",
      checkpoint: "b".repeat(40), client: "phone", decisionDurationMs: 4_000, ranForMs: 38_000, createdAt: "2026-09-23T12:00:00.000Z",
    }
    expect(threadItemSchema.parse(receipt)).toEqual(receipt)
    const { ranForMs: _ran, ...withoutRun } = receipt
    expect(threadItemSchema.parse(withoutRun)).not.toHaveProperty("ranForMs")
    for (const ranForMs of [-1, 1.5, "38s"]) expect(threadItemSchema.safeParse({ ...receipt, ranForMs }).success, String(ranForMs)).toBe(false)
    const entry = {
      id: "thread:receipt", sourceId: "receipt", sessionId: "session", category: "approvals", decision: "allow-once",
      operation: "Run migrations", checkpoint: "b".repeat(40), client: "phone", ranForMs: 38_000, createdAt: receipt.createdAt,
    }
    expect(sessionHistoryEntrySchema.parse(entry)).toEqual(entry)
  })

  it("keeps the provider item a gate belongs to on the approval", () => {
    const approval = {
      id: "approval", sessionId: "session", risk: "normal", operation: "Run migrations", command: "pnpm migrate",
      machine: "m", agent: "codex / gpt", mode: "build", directory: ".", affects: "files", network: "none",
      estimatedDuration: "Unknown", checkpoint: "unavailable", requestedAt: "2026-09-23T12:00:00.000Z",
      execution: { state: "unresolved", reason: "unsupported-syntax" }, itemId: "call_7f24",
    }
    expect(approvalRequestSchema.parse(approval)).toMatchObject({ itemId: "call_7f24" })
    expect(approvalRequestSchema.safeParse({ ...approval, itemId: "" }).success).toBe(false)
    expect(approvalRequestSchema.safeParse({ ...approval, itemId: "x".repeat(257) }).success).toBe(false)
  })
})



describe("mid-turn checkpoints", () => {
  const matched = { providerTurnId: "provider-turn-1", stability: "matched", changedPaths: [], changedPathCount: 0 }
  const unstable = { providerTurnId: "provider-turn-1", stability: "unstable", changedPaths: ["src/a.ts", " "], changedPathCount: 2 }
  it("accepts a bounded turn ID without narrowing the session identity contract", () => {
    const providerTurnId = "turn-" + "😀".repeat(2_000)
    expect(sessionSummarySchema.shape.activeTurnId.parse(providerTurnId)).toBe(providerTurnId)
    const midTurn = { ...matched, providerTurnId: "😀".repeat(512) }
    expect(threadItemSchema.parse({ ...checkpoint, midTurn })).toEqual({ ...checkpoint, midTurn })
    expect(sessionHistoryEntrySchema.parse({ ...history, midTurn })).toEqual({ ...history, midTurn })
  })
  it("accepts a digest instead of copying an oversized provider turn ID", () => {
    const { providerTurnId: _id, ...facts } = matched
    const midTurn = { ...facts, providerTurnIdSha256: "a".repeat(64) }
    expect(threadItemSchema.parse({ ...checkpoint, midTurn })).toEqual({ ...checkpoint, midTurn })
    expect(sessionHistoryEntrySchema.parse({ ...history, midTurn })).toEqual({ ...history, midTurn })
  })
  it("accepts the exact UTF-16 turn ID budget", () => {
    const midTurn = { ...matched, providerTurnId: "t".repeat(1024) }
    expect(threadItemSchema.parse({ ...checkpoint, midTurn })).toEqual({ ...checkpoint, midTurn })
    expect(sessionHistoryEntrySchema.parse({ ...history, midTurn })).toEqual({ ...history, midTurn })
  })
  it.each([
    { providerTurnId: "t".repeat(1025) },
    { providerTurnId: "漢".repeat(1025) },
    { providerTurnId: "😀".repeat(513) },
    { providerTurnId: undefined },
    { providerTurnId: "turn", providerTurnIdSha256: "a".repeat(64) },
    { providerTurnId: undefined, providerTurnIdSha256: "a".repeat(63) },
    { providerTurnId: undefined, providerTurnIdSha256: "G".repeat(64) },
  ])("rejects oversized or ambiguous turn identity: %#", (identity) => {
    const midTurn = { ...matched, ...identity }
    expect(threadItemSchema.safeParse({ ...checkpoint, midTurn }).success).toBe(false)
    expect(sessionHistoryEntrySchema.safeParse({ ...history, midTurn }).success).toBe(false)
  })
  const exactBudgetPaths = ["a".repeat(4095), "b".repeat(4092), "c".repeat(4092), "d".repeat(4092)]
  it("accepts the exact 16 KiB serialized path budget", () => {
    expect(new TextEncoder().encode(JSON.stringify(exactBudgetPaths)).byteLength).toBe(16 * 1024)
    const midTurn = { ...unstable, changedPaths: exactBudgetPaths, changedPathCount: 4 }
    expect(threadItemSchema.parse({ ...checkpoint, midTurn })).toEqual({ ...checkpoint, midTurn })
    expect(sessionHistoryEntrySchema.parse({ ...history, midTurn })).toEqual({ ...history, midTurn })
  })
  it.each([
    [...exactBudgetPaths.slice(0, 3), "d".repeat(4093)],
    ["漢".repeat(4096), "語".repeat(4096)],
    ["\u0001".repeat(3000)],
  ].map((changedPaths) => ({ changedPaths })))("rejects path details over the serialized byte budget: %#", ({ changedPaths }) => {
    expect(new TextEncoder().encode(JSON.stringify(changedPaths)).byteLength).toBeGreaterThan(16 * 1024)
    const midTurn = { ...unstable, changedPaths, changedPathCount: changedPaths.length }
    expect(threadItemSchema.safeParse({ ...checkpoint, midTurn }).success).toBe(false)
    expect(sessionHistoryEntrySchema.safeParse({ ...history, midTurn }).success).toBe(false)
  })
  it.each([matched, unstable,
    { ...unstable, changedPaths: Array.from({ length: 50 }, (_, index) => `file-${index}`), changedPathCount: 75 },
    { ...unstable, changedPaths: ["x".repeat(4096)], changedPathCount: 1 },
    { ...unstable, changedPaths: ["😀".repeat(2048)], changedPathCount: 100_001 },
    { ...unstable, changedPaths: [], changedPathCount: 1 },
    { ...unstable, changedPaths: [], changedPathCount: 0 },
  ])("preserves capture facts in thread and history: %j", (midTurn) => {
    expect(threadItemSchema.parse({ ...checkpoint, midTurn })).toEqual({ ...checkpoint, midTurn })
    expect(sessionHistoryEntrySchema.parse({ ...history, midTurn })).toEqual({ ...history, midTurn })
  })
  it.each([
    { ...matched, providerTurnId: "" },
    { ...matched, stability: "atomic" },
    { ...matched, changedPaths: ["a.ts"] },
    { ...matched, changedPathCount: 1 },
    { ...unstable, changedPathCount: 1 },
    { ...unstable, changedPathCount: -1 },
    { ...unstable, changedPathCount: 1.5 },
    { ...unstable, changedPathCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...unstable, changedPathCount: "2" },
    { ...unstable, changedPathCount: undefined },
    { ...unstable, changedPaths: Array.from({ length: 51 }, (_, index) => `file-${index}`), changedPathCount: 51 },
    { ...unstable, changedPaths: [""] },
    { ...unstable, changedPaths: ["x".repeat(4097)] },
    { ...unstable, changedPaths: ["😀".repeat(2049)] },
    { ...unstable, changedPaths: [1] },
    { ...matched, unexpected: true },
  ])("rejects invalid capture facts in thread and history: %j", (midTurn) => {
    expect(threadItemSchema.safeParse({ ...checkpoint, midTurn }).success).toBe(false)
    expect(sessionHistoryEntrySchema.safeParse({ ...history, midTurn }).success).toBe(false)
  })
})
