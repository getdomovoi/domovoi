import { describe, expect, it } from "vitest"
import { demoWorkspace } from "./fixtures.js"
import { sessionHistoryPageSchema, workspaceDeltaSchema } from "./rpc.js"
import { threadItemSchema } from "./schema.js"
import { sessionTransferStateSchema } from "./transfer-contract.js"
import { usageAccountingSchema } from "./usage-accounting.js"
import { applyWorkspaceDelta } from "./workspace-delta.js"

const id = "a".repeat(64)
const startedAt = "2026-09-10T12:00:00.000Z"
const completedAt = "2026-09-10T12:01:00.000Z"
const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costSource: "unavailable" }
const accounting = {
  version: 1, key: id, threadKey: "b".repeat(64), providerTurnId: "provider-turn",
  requestedModel: "requested/model", status: "completed", coverage: "unavailable", observations: [],
  turn: { ordinal: 3, startedAt, completedAt },
}
const turn = {
  id, sessionId: "session", ordinal: 3, startedAt, completedAt,
  provider: "opencode", requestedModel: "requested/model", reportedModels: [],
  status: "completed", coverage: "unavailable", usage, recordedToolCount: 2,
}
const message = { id: "message", sessionId: "session", kind: "user", body: "Steer the same turn", createdAt: startedAt, turnId: id }
const entry = { id: "thread:message", sourceId: "message", sessionId: "session", category: "messages", role: "user", body: message.body, createdAt: startedAt, turnId: id, turn }
const page = { sessionId: "session", items: [entry], hasMore: false }
const portable = {
  version: 1,
  session: { id: "session", title: "Session", runtime: { provider: "opencode", model: "requested/model", reasoning: "high", permissionMode: "build" }, changedFiles: 0, testsPassed: 0, testsFailed: 0, updatedAt: completedAt, baseCommit: "c".repeat(40), ownershipGeneration: 0 },
  thread: [message], artifacts: [], annotations: [],
  usage: [{ turnId: id, provider: "opencode", model: "requested/model", ...usage, accounting }],
}

describe("durable turn links", () => {
  it("preserves a dispatch ordinal and exact link through history and transfer", () => {
    expect(usageAccountingSchema.parse(accounting)).toEqual(accounting)
    expect(threadItemSchema.parse(message)).toEqual(message)
    expect(sessionHistoryPageSchema.parse(page)).toEqual(page)
    expect(sessionTransferStateSchema.parse(portable)).toEqual(portable)
  })

  it("keeps legacy accounting and messages unnumbered", () => {
    const { turn: _turn, ...legacyAccounting } = accounting
    const { turnId: _turnId, ...legacyMessage } = message
    expect(usageAccountingSchema.parse(legacyAccounting)).toEqual(legacyAccounting)
    expect(threadItemSchema.parse(legacyMessage)).toEqual(legacyMessage)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid ordinal %s", (ordinal) => {
    expect(usageAccountingSchema.safeParse({ ...accounting, turn: { ...accounting.turn, ordinal } }).success).toBe(false)
    expect(sessionHistoryPageSchema.safeParse({ ...page, items: [{ ...entry, turn: { ...turn, ordinal } }] }).success).toBe(false)
  })

  it("requires terminal dates, valid identities, and matching history ownership", () => {
    for (const change of [{ completedAt: undefined }, { startedAt: "yesterday" }]) {
      expect(usageAccountingSchema.safeParse({ ...accounting, turn: { ...accounting.turn, ...change } }).success).toBe(false)
    }
    expect(usageAccountingSchema.safeParse({ ...accounting, status: "pending", coverage: "pending" }).success).toBe(false)
    for (const change of [{ id: "d".repeat(64) }, { sessionId: "another-session" }, { status: "pending" }, { completedAt: undefined }, { recordedToolCount: -1 }]) {
      expect(sessionHistoryPageSchema.safeParse({ ...page, items: [{ ...entry, turn: { ...turn, ...change } }] }).success).toBe(false)
    }
    expect(threadItemSchema.safeParse({ ...message, turnId: "provider-turn" }).success).toBe(false)
  })

  it("refuses dangling transferred links and duplicate ordinals", () => {
    expect(sessionTransferStateSchema.safeParse({ ...portable, usage: [] }).success).toBe(false)
    const otherId = "d".repeat(64)
    const other = { ...portable.usage[0], turnId: otherId, accounting: { ...accounting, key: otherId, providerTurnId: "other" } }
    expect(sessionTransferStateSchema.safeParse({ ...portable, usage: [...portable.usage, other] }).success).toBe(false)
  })

  it.each(["assistant.append", "tool-output.append"] as const)("preserves turn links in %s deltas", (kind) => {
    const snapshot = structuredClone(demoWorkspace)
    const sessionId = snapshot.sessions[0]!.id
    const delta = workspaceDeltaSchema.parse({ sessionId, updatedAt: startedAt, operations: [{ kind, id: "streamed", turnId: id, delta: "First", createdAt: startedAt }] })
    const updated = applyWorkspaceDelta(applyWorkspaceDelta(snapshot, delta), delta)
    expect(updated.thread.find((item) => item.id === "streamed")).toMatchObject({ turnId: id })
  })
})
