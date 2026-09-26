import { describe, expect, it } from "vitest"
import { approvalRequestSchema, threadItemSchema } from "./schema.js"
import { sessionHistoryEntrySchema } from "./rpc.js"

const checkpoint = { id: "checkpoint", sessionId: "session", kind: "checkpoint", label: "Words a person chose", commit: "a".repeat(40), createdAt: "2026-09-10T12:00:00.000Z" }
const history = { id: "thread:checkpoint", sourceId: checkpoint.id, sessionId: checkpoint.sessionId, category: "checkpoints", label: checkpoint.label, commit: checkpoint.commit, createdAt: checkpoint.createdAt }

describe("checkpoint reasons", () => {
  it.each(["session-start", "fork", "manual", "before-restore", "before-revert", "before-provider-handoff", "before-provider-recovery", "before-archive"])("preserves %s independently of the label and commit", (reason) => {
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

