import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { demoWorkspace } from "@getdomovoi/protocol"
import { UsageLedger, normalizeUsage } from "./usage.js"
import { usageIdentity } from "./usage-accounting.js"
import { DomovoiDaemon, SessionHistoryIndex } from "./server.js"
import type { AgentAdapter, AgentEvent } from "./agents.js"
import { SqliteWorkspaceStore } from "./store.js"
import { importSessionTransferState, portableSessionTransferState } from "./session-transfer-state.js"
import { waitForDaemon } from "./test-wait-for.js"
import { removeScratchDirectory } from "./test-scratch.js"

const dispatch = { sessionId: "session", provider: "opencode", model: "requested/model", threadId: "provider-thread", turnId: "first" }
const startedAt = "2026-09-10T12:00:00.000Z"

describe("durable turn ordinals", () => {
  it.each(["restart", "transfer"] as const)("routes a steering report from its persisted message link after %s", async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-steering-link-"))
    const snapshot = structuredClone(demoWorkspace)
    snapshot.approvals = []
    snapshot.workingPlans = []
    snapshot.artifacts = []
    snapshot.annotations = []
    snapshot.approvalRules = []
    snapshot.sessions = [snapshot.sessions[0]!]
    const session = snapshot.sessions[0]!
    session.state = "idle"
    session.baseCommit = "c".repeat(40)
    session.workspacePath = directory
    session.runtime.provider = dispatch.provider
    session.runtime.model = "later/model"
    session.providerThreadId = dispatch.threadId
    delete session.activeTurnId
    snapshot.activeSessionId = session.id
    const identity = { ...dispatch, sessionId: session.id }
    const turnId = usageIdentity(identity)
    const messageIdentity = { ...identity, turnId: "steering-message" }
    snapshot.thread = [{ id: "steered", kind: "user", sessionId: session.id, body: "Steer", createdAt: startedAt,
      turnId, providerMessageKey: usageIdentity(messageIdentity) }]
    const source = new UsageLedger(join(directory, "source-usage.sqlite"))
    source.begin(identity)
    source.finish(identity, "completed")
    const records = source.transferSession(session.id)
    source.close()
    let arriving = snapshot
    if (boundary === "transfer") {
      const state = portableSessionTransferState(snapshot, session.id, records)
      const target = structuredClone(snapshot)
      target.machine.id = `machine-${"f".repeat(32)}`
      target.project!.machineId = target.machine.id
      target.sessions = []
      target.thread = []
      target.activeSessionId = null
      arriving = importSessionTransferState(target, state, {
        sourceMachineId: snapshot.machine.id, targetProjectId: target.project!.id, workspacePath: directory,
        transferId: `transfer-${"d".repeat(32)}`, manifestDigest: `sha256:${"e".repeat(64)}`,
        ownershipGeneration: 1, checkpointCommit: session.baseCommit, completedAt: startedAt,
        coverage: { included: [], excluded: [], warnings: [] },
      })
    }
    const statePath = join(directory, "workspace.sqlite")
    const beforeRestart = new SqliteWorkspaceStore(statePath, arriving)
    await beforeRestart.close()
    const store = new SqliteWorkspaceStore(statePath, demoWorkspace)
    const ledger = new UsageLedger(join(directory, boundary === "restart" ? "source-usage.sqlite" : "target-usage.sqlite"))
    if (boundary === "transfer") ledger.replaceTransferredSession(session.id, records)
    let listener: ((event: AgentEvent) => void) | undefined
    const agent: AgentAdapter = {
      connect: async () => {}, listModels: async () => [], startThread: async () => "unused", resumeThread: async () => {},
      stopThread: async () => {}, startTurn: async () => "unused", steerTurn: async () => {}, interruptTurn: async () => {},
      resolveApproval: () => {}, onEvent: (next) => { listener = next; return () => { listener = undefined } }, close: async () => {},
    }
    const daemon = new DomovoiDaemon({ port: 0, store, usageLedger: ledger, agents: { opencode: agent } })
    try {
      await daemon.start()
      listener!({ type: "usage", threadId: identity.threadId, turnId: messageIdentity.turnId,
        usage: normalizeUsage({ inputTokens: 17 }), source: { kind: "message", id: "steered-reply", tokens: "reported" } })
      await waitForDaemon(() => expect(ledger.session(session.id).totalTokens).toBe(17))
      expect(ledger.turns(session.id, [turnId])[0]).toMatchObject({ ordinal: 1, requestedModel: dispatch.model, coverage: "complete" })
      expect(store.load().thread.find((item) => item.id === "steered")).toMatchObject({ turnId, providerMessageKey: usageIdentity(messageIdentity) })
    } finally {
      await daemon.stop()
      await removeScratchDirectory(directory)
    }
  })

  it("allocates once per dispatch, independently of time, provider IDs and message count", () => {
    const ledger = new UsageLedger(":memory:", { now: () => Date.parse(startedAt) })
    try {
      ledger.begin(dispatch)
      ledger.begin({ ...dispatch, model: "do-not-restamp" })
      ledger.begin({ ...dispatch, threadId: "replacement-thread" })
      ledger.begin({ ...dispatch, sessionId: "another-session", threadId: "another-thread" })
      const first = ledger.lookup(dispatch)!
      expect(first.accounting?.turn).toEqual({ ordinal: 1, startedAt })
      expect(first.model).toBe("requested/model")
      expect(ledger.lookup({ ...dispatch, threadId: "replacement-thread" })?.accounting?.turn?.ordinal).toBe(2)
      expect(ledger.lookup({ ...dispatch, threadId: "another-thread" })?.accounting?.turn?.ordinal).toBe(1)
    } finally { ledger.close() }
  })

  it("preserves ordinals, end state and late reports across restart and transfer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-turn-ordinals-"))
    let ledger = new UsageLedger(join(directory, "usage.sqlite"), { now: () => Date.parse(startedAt) })
    const target = new UsageLedger()
    try {
      ledger.begin(dispatch)
      ledger.finish(dispatch, "failed")
      const second = { ...dispatch, turnId: "second" }
      ledger.begin(second)
      ledger.close()
      ledger = new UsageLedger(join(directory, "usage.sqlite"))
      ledger.interruptPending()
      const before = ledger.lookup(dispatch)!.accounting!.turn
      ledger.observe(dispatch, { usage: normalizeUsage({ inputTokens: 10 }), source: { kind: "turn", tokens: "reported", model: "actual/model" } })
      ledger.finish(dispatch, "completed")
      expect(ledger.lookup(dispatch)!.accounting!.turn).toEqual(before)
      expect(before).toEqual({ ordinal: 1, startedAt, completedAt: startedAt })
      const exported = ledger.transferSession(dispatch.sessionId)
      target.replaceTransferredSession(dispatch.sessionId, exported)
      expect(target.turns(dispatch.sessionId, [usageIdentity(dispatch), usageIdentity(second)]))
        .toMatchObject([{ ordinal: 1, status: "failed", reportedModels: ["actual/model"], usage: { totalTokens: 10 } }, { ordinal: 2, status: "interrupted" }])
      target.begin({ ...dispatch, threadId: "target-thread", turnId: "third" })
      expect(target.lookup({ ...dispatch, threadId: "target-thread", turnId: "third" })?.accounting?.turn?.ordinal).toBe(3)
      expect(target.window(0, Date.now() + 1000).totalTokens).toBe(0)
      const forged = structuredClone(exported)
      forged[1]!.accounting!.turn!.ordinal = 1
      const preserved = target.transferSession(dispatch.sessionId)
      expect(() => target.replaceTransferredSession(dispatch.sessionId, forged)).toThrow()
      expect(target.transferSession(dispatch.sessionId)).toEqual(preserved)
    } finally {
      ledger.close()
      target.close()
      await removeScratchDirectory(directory)
    }
  })

  it("never numbers legacy accounting or joins a different session", () => {
    const ledger = new UsageLedger()
    try {
      ledger.begin(dispatch)
      const legacy = ledger.transferSession(dispatch.sessionId)
      delete legacy[0]!.accounting!.turn
      ledger.replaceTransferredSession(dispatch.sessionId, legacy)
      ledger.begin(dispatch)
      expect(ledger.turns(dispatch.sessionId, [usageIdentity(dispatch)])).toEqual([])
      ledger.begin({ ...dispatch, turnId: "new" })
      expect(ledger.lookup({ ...dispatch, turnId: "new" })?.accounting?.turn?.ordinal).toBe(1)
      expect(ledger.turns("another-session", [usageIdentity(dispatch)])).toEqual([])
      expect(ledger.turns(dispatch.sessionId, ["unknown"])).toEqual([])
    } finally { ledger.close() }
  })

  it("joins fresh metadata after pagination and counts recorded tools outside the page", () => {
    const snapshot = structuredClone(demoWorkspace)
    const sessionId = snapshot.sessions[0]!.id
    const first = { ...dispatch, sessionId }
    const turnId = usageIdentity(first)
    snapshot.thread = [
      { id: "initiating", sessionId, turnId, kind: "user", body: "Start", createdAt: startedAt },
      { id: "tool", sessionId, turnId, kind: "tool", tool: "command", status: "completed", title: "test", createdAt: startedAt },
      { id: "reply", sessionId, turnId, kind: "assistant", body: "Done", createdAt: "2026-09-10T12:01:00.000Z" },
      { id: "legacy", sessionId, kind: "user", body: "No inferred link", createdAt: "2026-09-10T12:02:00.000Z" },
    ]
    const ledger = new UsageLedger()
    try {
      ledger.begin(first)
      ledger.finish(first, "completed")
      const index = new SessionHistoryIndex()
      const loadTurns = (ids: string[]) => ledger.turns(sessionId, ids)
      const params = { sessionId, limit: 2, categories: ["messages" as const] }
      expect(index.page(snapshot, params, undefined, loadTurns)?.items).toMatchObject([
        { sourceId: "reply", turnId, turn: { ordinal: 1, recordedToolCount: 1, coverage: "unavailable" } },
        { sourceId: "legacy" },
      ])
      expect(index.page(snapshot, params, undefined, loadTurns)?.items[1]).not.toHaveProperty("turn")
      ledger.observe(first, { usage: normalizeUsage({ inputTokens: 42 }) })
      expect(index.page(snapshot, params, undefined, loadTurns)?.items[0]?.turn)
        .toMatchObject({ ordinal: 1, coverage: "complete", usage: { totalTokens: 42 } })
    } finally { ledger.close() }
  })
})
