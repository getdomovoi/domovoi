import { describe, expect, it } from "vitest"
import { threadItemSchema } from "./schema.js"
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
})
