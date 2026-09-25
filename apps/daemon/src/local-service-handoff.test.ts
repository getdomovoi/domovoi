import { demoWorkspace, protocolVersion, serviceHandoffRefusal, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import type { AgentEvent } from "./agents.js"
import type { AgentAdapter } from "./codex.js"
import { holdServiceHandoffFence, readLocalServiceHandoffRefusal } from "./local-service-handoff.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratchDirectories: string[] = []
// Turns a test left unanswered, answered on cleanup so a failed assertion does
// not leave the daemon's stop waiting on them.
const heldTurns: ((turnId: string) => void)[] = []

afterEach(async () => {
  for (const answer of heldTurns.splice(0)) answer("turn-cleanup")
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories)
})

async function daemonWith(workspace: WorkspaceSnapshot, agent?: AgentAdapter) {
  // The profile and the skill catalog stay in scratch, never the real home.
  const profileDirectory = await mkdtemp(join(tmpdir(), "domovoi-fence-"))
  scratchDirectories.push(profileDirectory)
  const daemon = new DomovoiDaemon({
    port: 0, store: new SqliteWorkspaceStore(":memory:", workspace), profileDirectory,
    skillCatalog: { list: async () => [], read: async () => { throw new Error("No skills here") } },
    ...(agent ? { agent } : { agents: {} }),
  })
  daemons.push(daemon)
  const address = await daemon.start()
  return { url: `ws://${address.host}:${address.port}/rpc`, token: daemon.authToken }
}

// A turn the test starts and finishes: startTurn waits until the test lets it
// answer, so the dispatch is in flight for as long as the test needs.
function agentWithHeldTurns(held = true) {
  const pending = heldTurns
  const listeners: ((event: AgentEvent) => void)[] = []
  const agent = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(() => held ? new Promise<string>((resolve) => { pending.push(resolve) }) : Promise.resolve("turn-1")),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => { listeners.push(listener); return () => {} }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  return {
    agent,
    answer: (turnId: string) => pending.shift()?.(turnId),
    emit: (event: AgentEvent) => { for (const listener of listeners) listener(event) },
  }
}

async function readySession(): Promise<{ workspace: WorkspaceSnapshot; sessionId: string; title: string }> {
  const workspacePath = await mkdtemp(join(tmpdir(), "domovoi-fence-worktree-"))
  scratchDirectories.push(workspacePath)
  const workspace = quiet()
  const session = workspace.sessions[0]!
  session.runtime.provider = "codex"
  session.workspacePath = workspacePath
  session.providerThreadId = "thread-fence"
  workspace.thread = workspace.thread.filter((item) => item.sessionId !== session.id)
  return { workspace, sessionId: session.id, title: session.title }
}

type Reply = { result?: unknown; error?: { code: number; message: string } }

// A desktop connection on the daemon credential, hello already answered.
async function desktopConnection(endpoint: { url: string; token: string }) {
  const socket = new WebSocket(endpoint.url, { headers: { authorization: `Bearer ${endpoint.token}` } })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
  let id = 0
  const rpc = (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<Reply>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Reply & { id?: number }
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
  const hello = await rpc("system.hello", { client: "desktop", clientId: "desktop-fence-test", clientVersion: "0.0.1", protocolVersion })
  expect(hello.error).toBeUndefined()
  return rpc
}

function quiet(): WorkspaceSnapshot {
  const next = structuredClone(demoWorkspace)
  for (const session of next.sessions) { delete (session as { activeTurnId?: string }).activeTurnId; session.state = "idle" }
  next.approvals = []
  return next
}

describe("the desktop's own check before a service handoff", () => {
  it("reads the daemon's workspace and finds nothing in flight", async () => {
    const endpoint = await daemonWith(quiet())
    await expect(readLocalServiceHandoffRefusal({ endpoint, timeoutMs: 5_000 })).resolves.toBeUndefined()
  })

  it("names a waiting gate from the daemon's own workspace, as the renderer would", async () => {
    const workspace = quiet()
    const session = workspace.sessions[0]!
    workspace.approvals = [{ ...demoWorkspace.approvals[0]!, sessionId: session.id }]
    const endpoint = await daemonWith(workspace)
    const refusal = await readLocalServiceHandoffRefusal({ endpoint, timeoutMs: 5_000 })
    expect(refusal).toBe(serviceHandoffRefusal(workspace))
    expect(refusal).toContain("1 gate is waiting")
  })

  it("throws when the daemon cannot be read, rather than allowing the handoff", async () => {
    const endpoint = await daemonWith(quiet())
    await expect(readLocalServiceHandoffRefusal({ endpoint: { ...endpoint, token: "x".repeat(43) }, timeoutMs: 5_000 })).rejects.toThrow()
    await expect(readLocalServiceHandoffRefusal({ endpoint: { url: "http://127.0.0.1:1/rpc", token: endpoint.token }, timeoutMs: 5_000 })).rejects.toThrow()
  })
})

// Security review round 1 of #576. The read above is a snapshot; a turn can
// start between it and the stop. The fence is the same check taken inside the
// daemon, and it admits no new turn while the connection that took it is open.
describe("the service handoff fence", () => {
  it("refuses while a turn is being dispatched, naming its session", async () => {
    const { workspace, sessionId, title } = await readySession()
    const { agent, answer } = agentWithHeldTurns()
    const endpoint = await daemonWith(workspace, agent)
    const sender = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    const sending = sender("session.send", { sessionId, prompt: "go", client: "desktop" })
    await waitForDaemon(() => expect(agent.startTurn).toHaveBeenCalledOnce())
    await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({
      result: { outcome: "refused", refusal: `1 turn is running (${title}).` },
    })
    answer("turn-1")
    await expect(sending).resolves.toMatchObject({ result: expect.anything() })
    await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({
      result: { outcome: "refused", refusal: `1 turn is running (${title}).` },
    })
  })

  it("admits no new turn while held, and admits turns again once its connection closes", async () => {
    const { workspace, sessionId } = await readySession()
    const { agent } = agentWithHeldTurns(false)
    const endpoint = await daemonWith(workspace, agent)
    const sender = await desktopConnection(endpoint)
    const fence = await holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })
    expect(fence).toEqual({ release: expect.any(Function) })
    const refused = await sender("session.send", { sessionId, prompt: "go", client: "desktop" })
    expect(refused.error).toMatchObject({ code: -32602 })
    expect(agent.startTurn).not.toHaveBeenCalled()
    if ("release" in fence) fence.release()
    await waitForDaemon(async () => {
      const retry = await sender("session.send", { sessionId, prompt: "go", client: "desktop" })
      expect(retry.error).toBeUndefined()
    })
    expect(agent.startTurn).toHaveBeenCalledOnce()
  })

  it("answers the refusal instead of a fence while a gate waits", async () => {
    const workspace = quiet()
    workspace.approvals = [{ ...demoWorkspace.approvals[0]!, sessionId: workspace.sessions[0]!.id }]
    const endpoint = await daemonWith(workspace)
    await expect(holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })).resolves.toEqual({ refusal: serviceHandoffRefusal(workspace) })
  })

  it("holds one fence at a time", async () => {
    const endpoint = await daemonWith(quiet())
    const first = await holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })
    expect(first).toEqual({ release: expect.any(Function) })
    await expect(holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })).rejects.toThrow()
    if ("release" in first) first.release()
  })

  it("throws when the daemon cannot be reached, rather than reporting a fence", async () => {
    const endpoint = await daemonWith(quiet())
    await expect(holdServiceHandoffFence({ endpoint: { ...endpoint, token: "x".repeat(43) }, timeoutMs: 5_000 })).rejects.toThrow()
    await expect(holdServiceHandoffFence({ endpoint: { url: "http://127.0.0.1:1/rpc", token: endpoint.token }, timeoutMs: 5_000 })).rejects.toThrow()
  })

  // The owner rule: the switch waits while a gate waits, and interrupts
  // nothing. A request that arrives with no turn id is not dropped by the turn
  // check, so the fence itself must keep it from becoming a card. It is held,
  // not answered: nobody decides it for the person, and it becomes a card once
  // the fence lifts without a stop.
  it("raises no gate while held, and raises a turn-less request once the fence lifts", async () => {
    const { workspace, sessionId } = await readySession()
    const session = workspace.sessions.find(({ id }) => id === sessionId)!
    session.runtime.permissionMode = "ask"
    session.runtime.auto = false
    const { agent, emit } = agentWithHeldTurns(false)
    const endpoint = await daemonWith(workspace, agent)
    const reader = await desktopConnection(endpoint)
    const fence = await holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })
    expect(fence).toEqual({ release: expect.any(Function) })
    emit({ type: "approval-requested", requestId: 41, threadId: "thread-fence", command: "rm -rf build", cwd: session.workspacePath!, reason: "Remove the build output" })
    // Events for one session are handled in order, so once this later diff
    // shows, the approval request before it has been handled.
    emit({ type: "diff-updated", threadId: "thread-fence", diff: "marker" })
    await waitForDaemon(async () => {
      const read = await reader("workspace.get", {})
      expect((read.result as WorkspaceSnapshot).artifacts).toContainEqual(expect.objectContaining({ id: `diff-${sessionId}`, content: "marker" }))
    })
    const during = await reader("workspace.get", {})
    expect((during.result as WorkspaceSnapshot).approvals).toEqual([])
    expect(agent.resolveApproval).not.toHaveBeenCalled()

    if ("release" in fence) fence.release()
    await waitForDaemon(async () => {
      const read = await reader("workspace.get", {})
      expect((read.result as WorkspaceSnapshot).approvals).toMatchObject([{ sessionId, providerRequestId: 41 }])
    })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })
})
