import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  sessionTurnSchema,
  snapshotTurnSchema,
  usageAccountingSchema,
  workspaceSnapshotSchema,
} from "./index.js"

// Ruling Q401: turn start and end reach the snapshot that desktop and tablet
// both draw, so "Worked for N" and the header clock have one source. A turn the
// daemon lost to its own restart has no end time: the restart time is not when
// the turn ended.

const startedAt = "2026-10-02T12:00:00.000Z"
const completedAt = "2026-10-02T12:04:18.000Z"
const turn = { id: "a".repeat(64), sessionId: "session-billing", ordinal: 3, startedAt, completedAt, status: "completed" }

describe("snapshot turns", () => {
  it("carries each linked turn's start, end and status", () => {
    const running = { ...turn, id: "b".repeat(64), ordinal: 4, status: "pending", completedAt: undefined }
    const { completedAt: _end, ...pending } = running
    const lost = { id: "c".repeat(64), sessionId: "session-billing", ordinal: 2, startedAt, status: "interrupted" }
    const snapshot = { ...structuredClone(demoWorkspace), turns: [turn, pending, lost] }
    expect(workspaceSnapshotSchema.parse(snapshot).turns).toEqual([turn, pending, lost])
  })

  it("is absent from a snapshot that does not derive it", () => {
    expect(workspaceSnapshotSchema.parse(structuredClone(demoWorkspace))).not.toHaveProperty("turns")
  })

  it("ends a turn only when its status says it ended", () => {
    expect(snapshotTurnSchema.safeParse({ ...turn, status: "pending" }).success).toBe(false)
    for (const status of ["completed", "failed"]) {
      const { completedAt: _end, ...open } = turn
      expect(snapshotTurnSchema.safeParse({ ...open, status }).success, status).toBe(false)
      expect(snapshotTurnSchema.parse({ ...turn, status }).completedAt).toBe(completedAt)
    }
    // An interrupted turn has an end only when the daemon saw it end.
    expect(snapshotTurnSchema.parse({ ...turn, status: "interrupted" }).completedAt).toBe(completedAt)
  })

  it("refuses a malformed turn, usage it does not carry, and a duplicate", () => {
    for (const change of [{ id: "turn-1" }, { ordinal: 0 }, { startedAt: "yesterday" }, { completedAt: "later" }, { status: "running" }, { sessionId: "" }]) {
      expect(snapshotTurnSchema.safeParse({ ...turn, ...change }).success, JSON.stringify(change)).toBe(false)
    }
    expect(snapshotTurnSchema.safeParse({ ...turn, recordedToolCount: 2 }).success).toBe(false)
    expect(workspaceSnapshotSchema.safeParse({ ...structuredClone(demoWorkspace), turns: [turn, turn] }).success).toBe(false)
  })
})

describe("a turn the daemon recorded as ended on restart", () => {
  const accounting = {
    version: 1, key: turn.id, provider: "codex", threadKey: "d".repeat(64), providerTurnId: "provider-turn",
    requestedModel: "model", status: "interrupted", coverage: "unavailable", observations: [],
    turn: { ordinal: 3, startedAt, completedAt, completedAtSource: "daemon-restart" },
  }

  it("says its completedAt is when the restarted daemon recorded it, in the ledger and in history", () => {
    expect(usageAccountingSchema.parse(accounting).turn).toMatchObject({ completedAtSource: "daemon-restart" })
    const history = {
      ...turn, status: "interrupted", coverage: "unavailable", completedAtSource: "daemon-restart",
      provider: "codex", requestedModel: "model", reportedModels: [],
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costSource: "unavailable" },
      recordedToolCount: 0,
    }
    expect(sessionTurnSchema.parse(history)).toMatchObject({ completedAtSource: "daemon-restart" })
    expect(sessionTurnSchema.safeParse({ ...history, status: "completed" }).success).toBe(false)
  })

  it("is only an interrupted turn with a recorded time", () => {
    expect(usageAccountingSchema.safeParse({ ...accounting, status: "completed" }).success).toBe(false)
    expect(usageAccountingSchema.safeParse({ ...accounting, turn: { ...accounting.turn, completedAtSource: "provider" } }).success).toBe(false)
  })
})
