import { once } from "node:events"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { approvalPlanStep, demoWorkspace, protocolVersion, workspaceSnapshotSchema, type ClientKind, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const directories: string[] = []
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(directories)
})

async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-context-")))
  directories.push(workspace)
  const initial = structuredClone(demoWorkspace)
  const session = initial.sessions[0]!
  initial.sessions = [session]
  initial.approvals = []
  initial.approvalRules = []
  initial.workingPlans = []
  initial.thread = []
  initial.artifacts = []
  initial.annotations = []
  session.runtime = { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = workspace
  session.providerThreadId = "thread-context"
  delete session.activeTurnId
  let durable = initial
  let emit!: (event: AgentEvent) => void
  let turn = 0
  const agent = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => `turn-${++turn}`),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(), close: vi.fn(async () => {}),
    onEvent: (listener: (event: AgentEvent) => void) => { emit = listener; return () => {} },
  } satisfies AgentAdapter
  const daemon = new DomovoiDaemon({
    port: 0, profileDirectory: join(workspace, "profile"), agents: { codex: agent },
    store: { load: () => structuredClone(initial), save: (next: WorkspaceSnapshot) => { durable = structuredClone(next) }, close: () => {} },
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
  })
  daemons.push(daemon)
  const address = await daemon.start()
  async function connect(client: ClientKind, clientId?: string) {
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    sockets.push(socket)
    await once(socket, "open")
    let nextId = 0
    const rpc = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`${method} timed out`)) }, 3_000)
      const receive = (data: WebSocket.RawData) => {
        const reply = JSON.parse(data.toString()) as Record<string, unknown>
        if (reply.id !== id) return
        clearTimeout(timer)
        socket.off("message", receive)
        resolve(reply)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
    const hello = await rpc("system.hello", {
      client, ...(clientId === undefined ? {} : { clientId }), clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })
    expect(hello).not.toHaveProperty("error")
    return { rpc, connectionId: (hello.result as { connectionId: string }).connectionId }
  }
  let requestId = 0
  const request = (turnId?: string, extra: Partial<Extract<AgentEvent, { type: "approval-requested" }>> = {}) => {
    emit({ type: "approval-requested", threadId: session.providerThreadId!, ...(turnId ? { turnId } : {}), requestId: ++requestId,
      command: "git push", cwd: workspace, cwdSource: "request", ...extra })
  }
  return { connect, request, emit: (event: AgentEvent) => emit(event), agent, sessionId: session.id, workspace, durable: () => durable }
}

describe("approval turn context", () => {
  it("attributes an ACP-style permission event and preserves its plan blocker and settlement", async () => {
    const context = await fixture()
    const client = await context.connect("desktop", "acp-origin")
    expect(await client.rpc("session.send", { sessionId: context.sessionId, prompt: "Start", client: "desktop" }))
      .not.toHaveProperty("error")
    context.emit({ type: "plan-updated", threadId: "thread-context", turnId: "turn-1", steps: [
      { text: "Publish", status: "in-progress" },
    ] })
    context.emit({
      type: "approval-requested", requestId: 42, threadId: "thread-context", turnId: "turn-1",
      itemId: "acp-tool", command: "git push", reason: "Run command",
    })
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(1))
    const snapshot = workspaceSnapshotSchema.parse((await client.rpc("workspace.get", {})).result)
    const approval = snapshot.approvals[0]!
    expect(approval.origin).toEqual({ client: "desktop", clientId: "acp-origin", connectionId: client.connectionId })
    expect(approvalPlanStep(snapshot.workingPlans, approval)).toEqual({ step: 1, of: 1 })
    expect(approval).not.toHaveProperty("outsideProject")
    expect(approval).toMatchObject({ directory: context.workspace, execution: { state: "resolved", record: { cwd: "." } } })
    expect(await client.rpc("approval.resolve", { approvalId: approval.id, decision: "deny", client: "desktop" }))
      .not.toHaveProperty("error")
    expect(context.agent.resolveApproval).toHaveBeenCalledWith(42, "deny")
    expect(context.durable().approvals).toEqual([])
    expect(context.durable().workingPlans[0]!.steps[0]).not.toHaveProperty("blocker")
  })

  it.each(["session", "request"] as const)("uses only request cwd provenance for command facts: %s", async (source) => {
    const context = await fixture()
    const client = await context.connect("desktop")
    expect(await client.rpc("session.send", { sessionId: context.sessionId, prompt: "Start", client: "desktop" }))
      .not.toHaveProperty("error")
    context.emit({
      type: "approval-requested", requestId: 42, threadId: "thread-context", turnId: "turn-1",
      command: "git push", cwd: context.workspace,
      ...(source === "request" ? { cwdSource: "request" as const } : {}),
    })
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(1))
    const snapshot = workspaceSnapshotSchema.parse((await client.rpc("workspace.get", {})).result)
    const approval = snapshot.approvals[0]!
    if (source === "request") expect(approval.outsideProject).toEqual({ outside: false, basis: "working-directory" })
    else expect(approval).not.toHaveProperty("outsideProject")
    expect(approval.directory).toBe(context.workspace)
    expect(approval.execution).toMatchObject({ state: "resolved", record: { kind: "shell", cwd: "." } })
  })

  it.each(["phone", "tablet"] as const)("persists origin and containment and delivers them with plans to %s", async (handheld) => {
    const context = await fixture()
    const desktop = await context.connect("desktop", "desktop-origin")
    // An approval can arrive before startTurn resolves. The session mutation
    // queue must attach it to the dispatch that just started.
    context.agent.startTurn.mockImplementationOnce(async () => {
      context.request("turn-1")
      return "turn-1"
    })
    expect(await desktop.rpc("session.send", { sessionId: context.sessionId, prompt: "Publish", client: "desktop" })).not.toHaveProperty("error")
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(1))
    const origin = { client: "desktop", clientId: "desktop-origin", connectionId: desktop.connectionId }
    expect(context.durable().approvals[0]).toMatchObject({ origin, outsideProject: { outside: false, basis: "working-directory" } })

    context.emit({ type: "plan-updated", threadId: "thread-context", turnId: "turn-1", steps: [
      { text: "Inspect", status: "completed" }, { text: "Publish", status: "in-progress" }, { text: "Verify", status: "pending" },
    ] })
    await waitForDaemon(() => expect(context.durable().workingPlans[0]?.steps).toHaveLength(3))
    context.request("turn-1")
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(2))
    const phone = await context.connect(handheld)
    const snapshot = workspaceSnapshotSchema.parse((await phone.rpc("workspace.get", {})).result)
    const approval = snapshot.approvals[1]!
    expect(approval).toMatchObject({ origin, outsideProject: { outside: false, basis: "working-directory" } })
    expect(origin.connectionId).not.toBe(phone.connectionId)
    expect(approvalPlanStep(snapshot.workingPlans, approval)).toEqual({ step: 2, of: 3 })
  })

  it("does not attribute unknown turns, unlinked requests, or steering to the latest sender", async () => {
    const context = await fixture()
    const first = await context.connect("desktop")
    context.request()
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(1))
    expect(context.durable().approvals[0]).not.toHaveProperty("origin")
    await first.rpc("approval.resolve", { approvalId: context.durable().approvals[0]!.id, decision: "deny", client: "desktop" })
    expect(await first.rpc("session.send", { sessionId: context.sessionId, prompt: "Start", client: "desktop" })).not.toHaveProperty("error")
    const second = await context.connect("web", "second")
    expect(await second.rpc("session.send", { sessionId: context.sessionId, prompt: "Steer", client: "web" })).not.toHaveProperty("error")
    context.request("turn-1")
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(1))
    expect(context.durable().approvals[0]!.origin).toEqual({ client: "desktop", connectionId: first.connectionId })
    context.request()
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(2))
    expect(context.durable().approvals[1]).not.toHaveProperty("origin")
  })

  it("attributes a released queued send to its original connection", async () => {
    const context = await fixture()
    const first = await context.connect("desktop", "first")
    const second = await context.connect("phone", "queued-origin")
    await first.rpc("session.send", { sessionId: context.sessionId, prompt: "Start", client: "desktop" })
    expect(await second.rpc("session.send", { sessionId: context.sessionId, prompt: "Next", client: "phone", delivery: "next-turn-replace" }))
      .not.toHaveProperty("error")
    context.emit({ type: "turn-completed", params: { threadId: "thread-context", turn: { id: "turn-1", status: "completed" } } })
    await waitForDaemon(() => expect(context.durable().sessions[0]?.activeTurnId).toBe("turn-2"))
    context.request("turn-2")
    await waitForDaemon(() => expect(context.durable().approvals).toHaveLength(1))
    expect(context.durable().approvals[0]!.origin).toEqual({ client: "phone", clientId: "queued-origin", connectionId: second.connectionId })
  })
})
