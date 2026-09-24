import { once } from "node:events"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  daemonPersistenceUnavailableErrorCode,
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter } from "./codex.js"
import { resolveCommandExecution } from "./execution-resolution.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const worktrees: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(worktrees)
})

// A worktree on disk, since a saved card is resolved again there at load and
// at the click.
function worktree(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "domovoi-decision-")))
  worktrees.push(directory)
  return directory
}

// The card a daemon saved for this command at the worktree: its record is
// the one resolved there, so it still matches when the daemon loads it.
const pendingCommand = "prisma migrate deploy"

function pendingCard(workspace: string): WorkspaceSnapshot["approvals"][number] {
  return {
    ...demoWorkspace.approvals[0]!,
    risk: "normal",
    providerRequestId: 41,
    command: pendingCommand,
    directory: workspace,
    execution: resolveCommandExecution({ command: pendingCommand }),
  }
}

function pendingApproval(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
  session.state = "waiting"
  session.workspacePath = worktree()
  session.providerThreadId = "thread-billing"
  delete session.activeTurnId
  snapshot.approvals = [pendingCard(session.workspacePath)]
  return workspaceSnapshotSchema.parse(snapshot)
}

function agent() {
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"),
    resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "unused"),
    steerTurn: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
}

async function connect(daemon: DomovoiDaemon, port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  const responses = new Map<number, (message: Record<string, unknown>) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number }
    if (message.id !== undefined) responses.get(message.id)?.(message)
  })
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
      const id = ++nextId
      responses.set(id, resolve)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  const hello = await rpc("system.hello", {
    client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })
  expect(hello.error).toBeUndefined()
  return rpc
}

describe("approval decisions", () => {
  it("answers the agent only after the decision is saved", async () => {
    const provider = agent()
    let failNext = true
    let parkNext = false
    let parked = () => {}
    let release = () => {}
    const parkedWrite = new Promise<void>((resolve) => { parked = resolve })
    const store = {
      load: () => pendingApproval(),
      save: vi.fn(),
      saveAsync: vi.fn(async () => {
        if (failNext) {
          failNext = false
          throw new Error("database is locked")
        }
        if (parkNext) {
          parkNext = false
          await new Promise<void>((resolve) => {
            release = resolve
            parked()
          })
        }
      }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)
    const decision = { approvalId: "approval-migrate", decision: "always-project", client: "desktop" }

    const refused = await rpc("approval.resolve", decision)
    expect(refused.error).toMatchObject({ code: daemonPersistenceUnavailableErrorCode })
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    const unchanged = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(unchanged.approvals.map((approval) => approval.id)).toEqual(["approval-migrate"])
    expect(unchanged.approvalRules).toEqual([])
    expect(unchanged.thread.some((item) => item.kind === "receipt")).toBe(false)
    expect(unchanged.sessions.find((session) => session.id === "session-billing")?.state).toBe("waiting")

    parkNext = true
    const accepted = rpc("approval.resolve", decision)
    await parkedWrite
    expect(provider.resolveApproval).not.toHaveBeenCalled()
    release()
    expect((await accepted).error).toBeUndefined()
    expect(provider.resolveApproval).toHaveBeenCalledOnce()
    expect(provider.resolveApproval).toHaveBeenCalledWith(41, "allow-once")
    const decided = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(decided.approvals).toEqual([])
    expect(decided.approvalRules).toEqual([expect.objectContaining({ status: "active", command: pendingCommand })])
    expect(decided.sessions.find((session) => session.id === "session-billing")?.state).toBe("active")
  })
  it("keeps an emergency stop that lands while the decision is being saved", async () => {
    const provider = agent()
    let parkNext = false
    let parked = () => {}
    let release = () => {}
    const parkedWrite = new Promise<void>((resolve) => { parked = resolve })
    const saved: WorkspaceSnapshot[] = []
    const store = {
      load: () => pendingApproval(),
      save: vi.fn(),
      saveAsync: vi.fn(async (snapshot: WorkspaceSnapshot) => {
        if (parkNext) {
          parkNext = false
          await new Promise<void>((resolve) => {
            release = resolve
            parked()
          })
        }
        saved.push(structuredClone(snapshot))
      }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)

    parkNext = true
    const decision = rpc("approval.resolve", {
      approvalId: "approval-migrate", decision: "always-project", client: "desktop",
    })
    await parkedWrite
    const other = await connect(daemon, port)
    const stop = other("system.emergencyStop", { client: "desktop" })
    await vi.waitFor(() => expect(provider.resolveApproval).toHaveBeenCalledWith(41, "deny"), { timeout: 5_000 })
    release()
    expect((await decision).error).toBeDefined()
    expect((await stop).error).toBeUndefined()

    expect(provider.resolveApproval.mock.calls).toEqual([[41, "deny"]])
    const live = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(live.approvals).toEqual([])
    expect(live.approvalRules).toEqual([])
    const receipts = live.thread.filter((item) => item.kind === "receipt")
    expect(receipts).toEqual([expect.objectContaining({ decision: "deny", explanation: "Emergency stop" })])
    expect(live.sessions.find((session) => session.id === "session-billing")?.state).not.toBe("active")
    const last = saved.at(-1)!
    expect(last.approvalRules).toEqual([])
    expect(last.thread.filter((item) => item.kind === "receipt"))
      .toEqual([expect.objectContaining({ decision: "deny", explanation: "Emergency stop" })])
  })

  it("shows the new receipt in cached session history", async () => {
    const provider = agent()
    const store = {
      load: () => pendingApproval(),
      save: vi.fn(),
      saveAsync: vi.fn(async () => {}),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)
    const history = async () => {
      const page = await rpc("session.history", { sessionId: "session-billing" })
      expect(page.error).toBeUndefined()
      return (page.result as { items: Array<{ id: string }> }).items.map(({ id }) => id)
    }

    const before = await history()
    const resolved = await rpc("approval.resolve", {
      approvalId: "approval-migrate", decision: "allow-once", client: "desktop",
    })
    expect(resolved.error).toBeUndefined()
    const receipt = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result).thread
      .find((item) => item.kind === "receipt")!
    expect(before.some((id) => id.includes(receipt.id))).toBe(false)
    expect((await history()).some((id) => id.includes(receipt.id))).toBe(true)
  })
  it("keeps the gate waiting when the agent cannot be told after the save", async () => {
    const provider = agent()
    provider.resolveApproval.mockImplementationOnce(() => { throw new Error("stdin closed") })
    const saved: WorkspaceSnapshot[] = []
    let failNext = false
    const store = {
      load: () => pendingApproval(),
      save: vi.fn(),
      saveAsync: vi.fn(async (snapshot: WorkspaceSnapshot) => {
        if (failNext) {
          failNext = false
          throw new Error("database is locked")
        }
        saved.push(structuredClone(snapshot))
      }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)
    const decision = { approvalId: "approval-migrate", decision: "always-project", client: "desktop" }
    const waiting = (snapshot: WorkspaceSnapshot) => {
      expect(snapshot.approvals.map((approval) => approval.id)).toEqual(["approval-migrate"])
      expect(snapshot.approvalRules).toEqual([])
      expect(snapshot.thread.some((item) => item.kind === "receipt")).toBe(false)
      expect(snapshot.sessions.find((session) => session.id === "session-billing")?.state).toBe("waiting")
    }

    const undelivered = await rpc("approval.resolve", decision)
    expect(undelivered.error).toEqual({
      code: -32603,
      message: "Domovoi could not reach the agent, so this decision was not applied. The approval is still waiting.",
    })
    waiting(workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result))
    waiting(saved.at(-1)!)

    const retried = await rpc("approval.resolve", decision)
    expect(retried.error).toBeUndefined()
    expect(provider.resolveApproval.mock.calls).toEqual([[41, "allow-once"], [41, "allow-once"]])
    const decided = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(decided.approvals).toEqual([])
    expect(decided.approvalRules).toEqual([expect.objectContaining({ status: "active" })])
    expect(decided.thread.filter((item) => item.kind === "receipt")).toHaveLength(1)
  })

  it("answers the persistence failure when the rollback cannot be saved either", async () => {
    const provider = agent()
    let failNext = false
    provider.resolveApproval.mockImplementationOnce(() => {
      failNext = true
      throw new Error("stdin closed")
    })
    const store = {
      load: () => pendingApproval(),
      save: vi.fn(),
      saveAsync: vi.fn(async () => {
        if (failNext) {
          failNext = false
          throw new Error("database is locked")
        }
      }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)

    const undelivered = await rpc("approval.resolve", {
      approvalId: "approval-migrate", decision: "always-project", client: "desktop",
    })
    expect(undelivered.error).toMatchObject({ code: daemonPersistenceUnavailableErrorCode })
    const live = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(live.approvals.map((approval) => approval.id)).toEqual(["approval-migrate"])
    expect(live.approvalRules).toEqual([])
    expect(live.thread.some((item) => item.kind === "receipt")).toBe(false)
  })
})

function reapprovals(): WorkspaceSnapshot {
  const snapshot = structuredClone(pendingApproval())
  const legacy = {
    id: "rule-legacy",
    projectId: snapshot.project!.id,
    operation: "Apply a production database migration",
    command: pendingCommand,
    createdBy: "desktop" as const,
    createdAt: "2026-08-01T12:00:00.000Z",
    useCount: 3,
    status: "inactive" as const,
    inactiveReason: "legacy-text-only" as const,
    inactivatedAt: "2026-08-20T12:00:00.000Z",
  }
  snapshot.approvalRules = [legacy]
  const second = snapshot.sessions.find((session) => session.id !== "session-billing")!
  second.runtime = { ...second.runtime, provider: "codex", model: "gpt-5.6-sol" }
  second.state = "waiting"
  second.workspacePath = worktree()
  second.providerThreadId = `thread-${second.id}`
  delete second.activeTurnId
  const reapproval = { reason: "legacy-text-only" as const, inactiveRuleIds: [legacy.id] }
  snapshot.approvals = [
    { ...snapshot.approvals[0]!, reapproval },
    { ...pendingCard(second.workspacePath), id: "approval-second", sessionId: second.id, providerRequestId: 42, reapproval },
  ]
  return workspaceSnapshotSchema.parse(snapshot)
}

describe("standing rule replacement links", () => {
  it("removes the replacement link a rolled-back decision set", async () => {
    const provider = agent()
    provider.resolveApproval.mockImplementationOnce(() => { throw new Error("stdin closed") })
    const store = {
      load: () => reapprovals(),
      save: vi.fn(),
      saveAsync: vi.fn(async () => {}),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const rpc = await connect(daemon, port)
    const before = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(before.approvals.map(({ id }) => id)).toEqual(["approval-migrate", "approval-second"])

    const undelivered = await rpc("approval.resolve", {
      approvalId: "approval-migrate", decision: "always-project", client: "desktop",
    })
    expect(undelivered.error).toMatchObject({ code: -32603 })
    const live = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
    expect(live.approvalRules).toEqual(before.approvalRules)
  })

  it("keeps another decision's replacement link when a concurrent one rolls back", async () => {
    const provider = agent()
    provider.resolveApproval.mockImplementation((requestId: number) => {
      if (requestId === 42) throw new Error("stdin closed")
    })
    let parkNext = false
    let parked = () => {}
    let release = () => {}
    const parkedWrite = new Promise<void>((resolve) => { parked = resolve })
    const store = {
      load: () => reapprovals(),
      save: vi.fn(),
      saveAsync: vi.fn(async () => {
        if (!parkNext) return
        parkNext = false
        await new Promise<void>((resolve) => {
          release = resolve
          parked()
        })
      }),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const first = await connect(daemon, port)
    const second = await connect(daemon, port)

    parkNext = true
    const decidedFirst = first("approval.resolve", {
      approvalId: "approval-migrate", decision: "always-project", client: "desktop",
    })
    await parkedWrite
    const decidedSecond = second("approval.resolve", {
      approvalId: "approval-second", decision: "always-project", client: "desktop",
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    expect((await decidedFirst).error).toBeUndefined()
    expect((await decidedSecond).error).toMatchObject({ code: -32603 })

    const live = workspaceSnapshotSchema.parse((await first("workspace.get", {})).result)
    const firstRule = live.approvalRules.find((rule) => rule.status === "active")!
    expect(live.approvalRules.map(({ id }) => id)).toEqual(["rule-legacy", firstRule.id])
    expect(live.approvalRules[0]).toMatchObject({ id: "rule-legacy", replacedByRuleId: firstRule.id })
    expect(live.approvals.map(({ id }) => id)).toEqual(["approval-second"])
  })
})
