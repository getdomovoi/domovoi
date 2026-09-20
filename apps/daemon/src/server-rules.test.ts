import { once } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import { resolveExecution } from "./execution-resolution.js"
import { SqliteWorkspaceStore } from "./store.js"
import { permissionHardGates } from "./permission-policy.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const roots: string[] = []
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
let requestId = 0
afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(roots)
})

function rpc(socket: WebSocket, method: string, params: Record<string, unknown> = {}) {
  const id = ++requestId
  return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No response for ${method}`)) }, 2_000)
    const cleanup = () => { clearTimeout(timer); socket.off("message", receive) }
    const receive = (bytes: WebSocket.RawData) => {
      const result = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { code: number; message: string } }
      if (result.id === id) { cleanup(); resolve(result) }
    }
    socket.on("message", receive)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function setup(permissionMode: "ask" | "build" = "build") {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-rules-"))
  roots.push(directory)
  await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode, auto: false }
  session.state = "idle"
  session.workspacePath = directory
  session.providerThreadId = "thread-rules"
  delete session.activeTurnId
  snapshot.approvals = []
  const execution = await resolveExecution({ workspaceRoot: directory, cwd: directory, command: "pnpm test" })
  if (execution.state !== "resolved") throw new Error("Fixture command was not resolved")
  snapshot.approvalRules = [{
    id: "rule-tests", projectId: snapshot.project!.id, operation: "Run tests", command: "pnpm test",
    status: "active", execution, createdBy: "desktop", createdAt: "2026-09-01T00:00:00.000Z", useCount: 0,
  }]
  let listener: ((event: AgentEvent) => void) | undefined
  const agent = {
    permissionCapabilities: { ask: "read-only", buildAuto: "pre-execution" },
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "thread-rules"), resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "turn-rules"),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}), resolveApproval: vi.fn(),
    onEvent: (next: (event: AgentEvent) => void) => { listener = next; return () => { listener = undefined } },
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const path = join(directory, "state.sqlite")
  const store = new SqliteWorkspaceStore(path, snapshot)
  const errorSink = vi.fn()
  const daemon = new DomovoiDaemon({ port: 0, store, agents: { "claude-code": agent }, errorSink })
  daemons.push(daemon)
  const address = await daemon.start()
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const hello = await rpc(socket, "system.hello", { client: "cli", clientId: "rules-owner", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })
  expect(hello.error).toBeUndefined()
  expect((await rpc(socket, "session.send", { sessionId: session.id, prompt: "Run tests", client: "cli" })).error).toBeUndefined()
  const emit = (id: number, reason = "Run tests", command = "pnpm test") => listener!({
    type: "approval-requested", requestId: id, threadId: "thread-rules", turnId: "turn-rules", reason, command, cwd: directory,
  })
  const emitPolicyRefusal = () => listener!({
    type: "policy-refused",
    threadId: "thread-rules",
    itemId: "tool-write",
    reason: "Write a generated file",
    command: "Write",
  } as AgentEvent)
  return { socket, store, agent, emit, emitPolicyRefusal, daemon, errorSink, path, directory, snapshot,
    connectionId: (hello.result as { connectionId: string }).connectionId }
}

describe("Rules daemon support", () => {
  it("persists each rule use before approving, then revokes without deleting its history", async () => {
    const { socket, store, agent, emit, daemon, path, connectionId, snapshot } = await setup()
    const observedCounts: number[] = []
    agent.resolveApproval.mockImplementation(() => { observedCounts.push(store.load().approvalRules[0]!.useCount) })
    emit(1)
    await waitForDaemon(() => expect(agent.resolveApproval).toHaveBeenCalledWith(1, "allow-once"))
    emit(2)
    await waitForDaemon(() => expect(agent.resolveApproval).toHaveBeenCalledWith(2, "allow-once"))
    expect(observedCounts).toEqual([1, 2])
    const revoked = await rpc(socket, "approvalRule.revoke", { ruleId: "rule-tests", client: "cli" })
    expect(revoked.error).toBeUndefined()
    const rule = (revoked.result as WorkspaceSnapshot).approvalRules[0]!
    expect(rule).toMatchObject({ status: "inactive", inactiveReason: "revoked", useCount: 2,
      execution: snapshot.approvalRules[0]!.status === "active" ? snapshot.approvalRules[0]!.execution : undefined,
      createdBy: "desktop", createdAt: "2026-09-01T00:00:00.000Z",
      inactivatedBy: "cli", inactivatedByConnectionId: connectionId, inactivatedByClientId: "rules-owner",
    })
    expect(rule.status === "inactive" && Date.parse(rule.inactivatedAt)).toBeGreaterThan(0)
    expect((await rpc(socket, "approvalRule.revoke", { ruleId: "rule-tests", client: "cli" })).result).toMatchObject({ approvalRules: [rule] })
    emit(3)
    const after = await rpc(socket, "workspace.get")
    expect(after.result).toMatchObject({ approvals: [expect.objectContaining({ providerRequestId: 3 })], approvalRules: [rule] })
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(3, "allow-once")
    expect(store.auditLog.query({ limit: 100 }).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "approvalRule.revoke", target: "rule-tests", actor: expect.objectContaining({ client: "cli" }) }),
    ]))
    socket.terminate()
    await daemon.stop()
    const reopened = new SqliteWorkspaceStore(path, demoWorkspace)
    try { expect(reopened.load().approvalRules).toEqual([rule]) } finally { await reopened.close() }
  })

  it("rejects unknown rules and forged client attribution", async () => {
    const { socket, store } = await setup()
    expect((await rpc(socket, "approvalRule.revoke", { ruleId: "missing", client: "cli" })).error?.code).toBe(-32602)
    expect((await rpc(socket, "approvalRule.revoke", { ruleId: "rule-tests", client: "desktop" })).error?.code).toBe(-32602)
    expect(store.load().approvalRules[0]!.status).toBe("active")
  })

  it("retries a failed revocation write before acknowledging an idempotent request", async () => {
    const { socket, store } = await setup()
    vi.spyOn(store, "saveAsync").mockRejectedValueOnce(new Error("injected revocation write failure"))
    const params = { ruleId: "rule-tests", client: "cli" }
    expect((await rpc(socket, "approvalRule.revoke", params)).error).toBeDefined()
    expect(store.load().approvalRules[0]!.status).toBe("active")
    expect((await rpc(socket, "approvalRule.revoke", params)).error).toBeUndefined()
    expect(store.load().approvalRules[0]).toMatchObject({ status: "inactive", inactiveReason: "revoked" })
  })

  it("does not count hard gates as uses of a matching rule", async () => {
    const { socket, store, emit, agent } = await setup()
    emit(4, "Run a database migration")
    const result = await rpc(socket, "workspace.get")
    expect(result.result).toMatchObject({ approvals: [expect.objectContaining({ risk: "hard-gate" })] })
    expect(store.load().approvalRules[0]!.useCount).toBe(0)
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(4, "allow-once")
  })

  it("denies the request if its increment cannot be persisted", async () => {
    const { store, emit, agent } = await setup()
    vi.spyOn(store, "saveAsync").mockRejectedValueOnce(new Error("injected rules write failure"))
    emit(5)
    await waitForDaemon(() => expect(agent.resolveApproval).toHaveBeenCalledWith(5, "deny"))
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(5, "allow-once")
    expect(store.load().approvalRules[0]!.useCount).toBe(0)
    expect(store.auditLog.query({ limit: 100 }).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "approval-rule.used", outcome: "denied", target: "rule-tests" }),
    ]))
  })

  it("persists and broadcasts Ask-mode refusals without creating an approval path", async () => {
    const { socket, store, agent, emitPolicyRefusal, daemon, errorSink, path, snapshot } = await setup("ask")
    const notifications: Array<{ method?: string; params?: WorkspaceSnapshot }> = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { method?: string; params?: WorkspaceSnapshot }
      if (message.method) notifications.push(message)
    })

    emitPolicyRefusal()
    await waitForDaemon(() => expect(
      store.load().thread.filter(({ kind }) => kind === "policy-refusal").length + errorSink.mock.calls.length,
    ).toBeGreaterThan(0))
    expect(errorSink).not.toHaveBeenCalled()
    await waitForDaemon(() => expect(store.load().thread.filter(({ kind }) => kind === "policy-refusal")).toHaveLength(1))
    const refusal = store.load().thread.find(({ kind }) => kind === "policy-refusal")
    expect(refusal).toMatchObject({
      kind: "policy-refusal",
      operation: "Write a generated file",
      command: "Write",
      rule: "Ask mode is read-only",
      setBy: "Domovoi permission mode",
      scope: "This session",
      remedy: "Switch to Plan or Build mode before asking the agent to write files.",
    })
    expect(store.load().approvals).toEqual([])
    expect(agent.resolveApproval).not.toHaveBeenCalled()
    expect((await rpc(socket, "approval.resolve", { approvalId: refusal!.id, decision: "allow-once", client: "cli" })).error)
      .toMatchObject({ code: -32602, message: "Approval does not exist" })
    expect((await rpc(socket, "session.history", {
      sessionId: snapshot.sessions[0]!.id,
      categories: ["policy-refusals"],
    })).result).toMatchObject({
      items: [expect.objectContaining({ sourceId: refusal!.id, category: "policy-refusals", rule: "Ask mode is read-only" })],
    })
    await waitForDaemon(() => expect(notifications.some((message) =>
      message.method === "workspace.changed"
      && message.params?.thread.some(({ id }) => id === refusal!.id),
    )).toBe(true))

    socket.terminate()
    await daemon.stop()
    const reopened = new SqliteWorkspaceStore(path, demoWorkspace)
    try {
      expect(reopened.load().thread).toContainEqual(refusal)
      expect(reopened.load().approvals).toEqual([])
    } finally {
      await reopened.close()
    }
  })

  it("returns the daemon policy's category data", async () => {
    const { socket } = await setup()
    const result = await rpc(socket, "permission.hardGates")
    expect(result.error).toBeUndefined()
    expect(result.result).toEqual(permissionHardGates())
    expect(result.result).toMatchObject({ categories: expect.arrayContaining([
      expect.objectContaining({ id: "destructive-operations", label: expect.stringContaining("force-push") }),
      expect.objectContaining({ id: "outside-project" }),
      expect.objectContaining({ id: "skill-installation" }),
    ]) })
  })
})
