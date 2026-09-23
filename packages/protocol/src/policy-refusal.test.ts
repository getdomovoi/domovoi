import { describe, expect, it } from "vitest"

import { sessionHistoryEntrySchema } from "./rpc.js"
import { threadItemSchema } from "./schema.js"

const refusal = {
  id: "refusal-1",
  sessionId: "session-a",
  turnId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  kind: "policy-refusal",
  operation: "Write files",
  command: "Write",
  rule: "Ask mode is read-only",
  setBy: "Domovoi permission mode",
  scope: "This session",
  remedy: "Switch to Plan or Build mode before asking the agent to write files.",
  createdAt: "2026-09-19T20:00:00.000Z",
} as const

describe("policy refusal thread items", () => {
  it("accepts complete durable refusal facts", () => {
    expect(threadItemSchema.parse(refusal)).toEqual(refusal)
  })

  it.each(["operation", "command", "rule", "setBy", "scope", "remedy"] as const)(
    "requires non-empty %s",
    (field) => {
      expect(threadItemSchema.safeParse({ ...refusal, [field]: "" }).success).toBe(false)
    },
  )

  it("rejects unknown fields", () => {
    expect(threadItemSchema.safeParse({ ...refusal, approvalId: "approval-1" }).success).toBe(false)
  })

  it("preserves refusal facts in session history", () => {
    const history = {
      ...refusal,
      id: "history:refusal-1",
      sourceId: refusal.id,
      category: "policy-refusals",
    }
    const { kind: _kind, ...entry } = history
    expect(sessionHistoryEntrySchema.parse(entry)).toEqual(entry)
    expect(sessionHistoryEntrySchema.safeParse({ ...entry, approvalId: "approval-1" }).success).toBe(false)
  })
})
