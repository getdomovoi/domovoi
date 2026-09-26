import { demoWorkspace, protocolVersion, serviceHandoffRefusal, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { execFileSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import type { AgentEvent } from "./agents.js"
import type { AgentAdapter } from "./codex.js"
import { holdServiceHandoffFence, readLocalServiceHandoffRefusal } from "./local-service-handoff.js"
import { DomovoiDaemon, serviceHandoffFencedMessage, serviceHandoffStopRefusal } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { TerminalProcess } from "./terminal.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

// Barriers the round 6 and 7 tests can hold inside each await between a
// provider's approval request and the answer to it. Each passes straight
// through unless a test arms it; an armed barrier holds its first call only.
type Barrier = { entered: () => void; release: Promise<void> }
const barriers = vi.hoisted(() => new Map<string, Barrier>())
const passBarrier = vi.hoisted(() => async (name: string) => {
  const held = barriers.get(name)
  if (!held) return
  barriers.delete(name)
  held.entered()
  await held.release
})
vi.mock("./file-target-affects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file-target-affects.js")>()
  return {
    ...actual,
    cardDirectory: async (...args: Parameters<typeof actual.cardDirectory>) => { await passBarrier("cardDirectory"); return actual.cardDirectory(...args) },
    // Main's settlement (approval-settlement.ts) judges a file target's path
    // through pathSpellings; fileTargetAffects no longer runs on this path.
    pathSpellings: async (...args: Parameters<typeof actual.pathSpellings>) => { await passBarrier("pathSpellings"); return actual.pathSpellings(...args) },
  }
})
vi.mock("./followed-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./followed-path.js")>()
  return {
    ...actual,
    fileTargetIdentity: async (...args: Parameters<typeof actual.fileTargetIdentity>) => { await passBarrier("fileTargetIdentity"); return actual.fileTargetIdentity(...args) },
  }
})
vi.mock("./execution-resolution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./execution-resolution.js")>()
  return {
    ...actual,
    resolveExecution: async (...args: Parameters<typeof actual.resolveExecution>) => { await passBarrier("resolveExecution"); return actual.resolveExecution(...args) },
  }
})

// Arms a barrier and returns what the test drives it with.
function arm(name: string) {
  let entered!: () => void
  const reached = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  barriers.set(name, { entered, release: new Promise<void>((resolve) => { release = resolve }) })
  return { reached, release: () => release() }
}

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

async function daemonWith(workspace: WorkspaceSnapshot, agent?: AgentAdapter, wrapStore?: (store: SqliteWorkspaceStore) => SqliteWorkspaceStore) {
  // The profile and the skill catalog stay in scratch, never the real home.
  const profileDirectory = await mkdtemp(join(tmpdir(), "domovoi-fence-"))
  scratchDirectories.push(profileDirectory)
  const daemon = new DomovoiDaemon({
    port: 0, store: (wrapStore ?? ((store) => store))(new SqliteWorkspaceStore(":memory:", workspace)), profileDirectory,
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

// A daemon expires every approval read back from storage at startup (#604),
// so a waiting gate has to be raised live: the provider asks, in ask mode.
async function daemonWithLiveGate(): Promise<{ endpoint: { url: string; token: string }; waiting: WorkspaceSnapshot }> {
  const { workspace, sessionId } = await readySession()
  const session = workspace.sessions.find(({ id }) => id === sessionId)!
  session.runtime.permissionMode = "ask"
  session.runtime.auto = false
  const { agent, emit } = agentWithHeldTurns(false)
  const endpoint = await daemonWith(workspace, agent)
  const reader = await desktopConnection(endpoint)
  emit({ type: "approval-requested", requestId: 7, threadId: "thread-fence", command: "rm -rf build", cwd: session.workspacePath!, reason: "Remove the build output" })
  const waiting = await waitForDaemon(async () => {
    const read = (await reader("workspace.get", {})).result as WorkspaceSnapshot
    expect(read.approvals).toMatchObject([{ sessionId, providerRequestId: 7 }])
    return read
  })
  return { endpoint, waiting }
}

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
    const { endpoint, waiting } = await daemonWithLiveGate()
    const refusal = await readLocalServiceHandoffRefusal({ endpoint, timeoutMs: 5_000 })
    expect(refusal).toBe(serviceHandoffRefusal(waiting))
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
    const { endpoint, waiting } = await daemonWithLiveGate()
    await expect(holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })).resolves.toEqual({ refusal: serviceHandoffRefusal(waiting) })
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

  // Security review rounds 6 and 7: a request already on its way to an
  // answer when the fence is taken must not be answered or become a card
  // until the fence lifts. Each await on that way is held on a barrier, the
  // fence is taken on a connection whose hello was answered before the
  // request arrived (a fresh connection's hello waits behind the request,
  // which the daemon must not rely on), and the barrier is let go.
  it.each([
    { await: "resolveExecution", file: false },
    { await: "cardDirectory", file: false },
    { await: "fileTargetIdentity", file: true },
    { await: "pathSpellings", file: true },
  ])("holds a request that was waiting on $await when the fence was taken", async ({ await: name, file }) => {
    const { workspace, sessionId } = await readySession()
    const session = workspace.sessions.find(({ id }) => id === sessionId)!
    session.runtime.permissionMode = "ask"
    session.runtime.auto = false
    const { agent, emit } = agentWithHeldTurns(false)
    const endpoint = await daemonWith(workspace, agent)
    const reader = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    const fencerSocket = sockets.at(-1)!
    const barrier = arm(name)
    emit(file
      ? { type: "approval-requested", requestId: 43, threadId: "thread-fence", command: "Edit", path: "notes.txt", cwd: session.workspacePath!, reason: "Edit the notes" }
      : { type: "approval-requested", requestId: 43, threadId: "thread-fence", command: "rm -rf build", cwd: session.workspacePath!, reason: "Remove the build output" })
    await barrier.reached
    await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({ result: { outcome: "fenced" } })
    barrier.release()
    emit({ type: "diff-updated", threadId: "thread-fence", diff: "after the card" })
    await waitForDaemon(async () => {
      const read = await reader("workspace.get", {})
      expect((read.result as WorkspaceSnapshot).artifacts).toContainEqual(expect.objectContaining({ id: `diff-${sessionId}`, content: "after the card" }))
    })
    const during = await reader("workspace.get", {})
    expect((during.result as WorkspaceSnapshot).approvals).toEqual([])
    expect(agent.resolveApproval).not.toHaveBeenCalled()

    fencerSocket.terminate()
    await waitForDaemon(async () => {
      const read = await reader("workspace.get", {})
      expect((read.result as WorkspaceSnapshot).approvals).toMatchObject([{ sessionId, providerRequestId: 43 }])
    })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  // A standing rule answers a request with no card, but only after its use
  // is saved. The save is held, the fence taken, and the save let go (or
  // failed): no answer may reach the provider while the fence is held, and
  // the rule's use counts once, when it is used.
  it.each([
    { save: "succeeds" },
    { save: "fails" },
  ])("holds a standing rule's answer when the fence is taken while its use is saved (the save $save)", async ({ save }) => {
    const { workspace, sessionId } = await readySession()
    const session = workspace.sessions.find(({ id }) => id === sessionId)!
    session.runtime.permissionMode = "ask"
    session.runtime.auto = false
    // An allow takes a checkpoint of the worktree first, so it is a repository.
    const git = (...args: string[]) => execFileSync("git", ["-C", session.workspacePath!, "-c", "user.name=Domovoi test", "-c", "user.email=test@domovoi.invalid", ...args], { stdio: "ignore" })
    git("init", "-q")
    git("commit", "-q", "--allow-empty", "-m", "start")
    const { agent, emit } = agentWithHeldTurns(false)
    const saveGate = { held: undefined as undefined | { entered: () => void; release: Promise<void>; fail: boolean } }
    const endpoint = await daemonWith(workspace, agent, (store) => {
      const saveAsync = store.saveAsync.bind(store)
      store.saveAsync = async (snapshot) => {
        const held = saveGate.held
        if (held) {
          saveGate.held = undefined
          held.entered()
          await held.release
          if (held.fail) throw new Error("simulated save failure")
        }
        return saveAsync(snapshot)
      }
      return store
    })
    const reader = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    const fencerSocket = sockets.at(-1)!
    const request = (requestId: number) => ({ type: "approval-requested" as const, requestId, threadId: "thread-fence", command: "ls", cwd: session.workspacePath!, reason: "List the files" })
    // The rule comes from the person: a card answered "always for this project".
    emit(request(50))
    const card = await waitForDaemon(async () => {
      const read = (await reader("workspace.get", {})).result as WorkspaceSnapshot
      expect(read.approvals).toMatchObject([{ providerRequestId: 50 }])
      return read.approvals[0]!
    })
    await expect(reader("approval.resolve", { approvalId: card.id, decision: "always-project", revision: card.revision, client: "desktop" })).resolves.toMatchObject({ result: expect.anything() })
    const rules = ((await reader("workspace.get", {})).result as WorkspaceSnapshot).approvalRules
    expect(rules).toMatchObject([{ status: "active", useCount: 0 }])
    agent.resolveApproval.mockClear()

    let entered!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    saveGate.held = { entered, release: new Promise<void>((resolve) => { release = resolve }), fail: save === "fails" }
    emit(request(51))
    await reached
    await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({ result: { outcome: "fenced" } })
    release()
    emit({ type: "diff-updated", threadId: "thread-fence", diff: "after the rule" })
    await waitForDaemon(async () => {
      const read = await reader("workspace.get", {})
      expect((read.result as WorkspaceSnapshot).artifacts).toContainEqual(expect.objectContaining({ id: `diff-${sessionId}`, content: "after the rule" }))
    })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
    const during = (await reader("workspace.get", {})).result as WorkspaceSnapshot
    expect(during.approvals).toEqual([])
    expect(during.approvalRules).toMatchObject([{ useCount: 0 }])

    fencerSocket.terminate()
    await waitForDaemon(() => expect(agent.resolveApproval).toHaveBeenCalledWith(51, "allow-once"))
    expect(agent.resolveApproval).toHaveBeenCalledOnce()
    await waitForDaemon(async () => {
      const read = (await reader("workspace.get", {})).result as WorkspaceSnapshot
      expect(read.approvalRules).toMatchObject([{ useCount: 1 }])
    })
  })

  // Merge check of 7de0db84: a request held behind the handoff fence must
  // never become a card or an allow after an emergency stop. The stop denies
  // it, as it denies any pending gate, whether it was held before the stop
  // began or arrived while the stop ran.
  it.each([
    { order: "held before the stop begins" },
    { order: "arriving while the stop runs" },
  ])("denies a turn-less request $order, and replays nothing when the fence lifts", async ({ order }) => {
    const { workspace, sessionId } = await readySession()
    const session = workspace.sessions.find(({ id }) => id === sessionId)!
    session.runtime.permissionMode = "ask"
    session.runtime.auto = false
    const { agent, emit } = agentWithHeldTurns(false)
    const saveGate = { held: undefined as undefined | { entered: () => void; release: Promise<void> } }
    const endpoint = await daemonWith(workspace, agent, (store) => {
      const saveAsync = store.saveAsync.bind(store)
      store.saveAsync = async (snapshot) => {
        const held = saveGate.held
        if (held) {
          saveGate.held = undefined
          held.entered()
          await held.release
        }
        return saveAsync(snapshot)
      }
      return store
    })
    const reader = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    const fencerSocket = sockets.at(-1)!
    await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({ result: { outcome: "fenced" } })
    const request = { type: "approval-requested" as const, requestId: 77, threadId: "thread-fence", command: "rm -rf build", cwd: session.workspacePath!, reason: "Remove the build output" }
    const handled = async (marker: string) => {
      emit({ type: "diff-updated", threadId: "thread-fence", diff: marker })
      await waitForDaemon(async () => {
        const read = await reader("workspace.get", {})
        expect((read.result as WorkspaceSnapshot).artifacts).toContainEqual(expect.objectContaining({ id: `diff-${sessionId}`, content: marker }))
      })
    }
    if (order === "held before the stop begins") {
      emit(request)
      await handled("held")
      await expect(reader("system.emergencyStop", { client: "desktop" })).resolves.toMatchObject({ result: expect.anything() })
      fencerSocket.terminate()
    } else {
      // The stop is kept running by holding its save of the agent state.
      let entered!: () => void
      const reached = new Promise<void>((resolve) => { entered = resolve })
      let release!: () => void
      saveGate.held = { entered, release: new Promise<void>((resolve) => { release = resolve }) }
      const stopping = reader("system.emergencyStop", { client: "desktop" })
      try {
        await reached
        emit(request)
        // While the stop runs its writes are held, so the request is watched
        // at the provider: the stop's deny must reach it before the fence
        // lifts.
        await waitForDaemon(() => expect(agent.resolveApproval).toHaveBeenCalledWith(77, "deny"))
        fencerSocket.terminate()
      } finally {
        release()
      }
      await expect(stopping).resolves.toMatchObject({ result: expect.anything() })
    }
    await handled("after the fence")
    const after = (await reader("workspace.get", {})).result as WorkspaceSnapshot
    expect(after.approvals).toEqual([])
    expect(agent.resolveApproval).toHaveBeenCalledWith(77, "deny")
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(77, "allow-once")
  })

  // Security review rounds 10 and 11: a request already settling when a stop
  // runs must be denied as the stop denies any pending gate, never held,
  // replayed, carded or allowed afterwards, with or without the fence. Each
  // await of card construction is held in turn.
  it.each([
    { await: "resolveExecution", file: false, fence: true },
    { await: "resolveExecution", file: false, fence: false },
    { await: "cardDirectory", file: false, fence: true },
    { await: "cardDirectory", file: false, fence: false },
    { await: "fileTargetIdentity", file: true, fence: true },
    { await: "fileTargetIdentity", file: true, fence: false },
    { await: "pathSpellings", file: true, fence: true },
    { await: "pathSpellings", file: true, fence: false },
  ])("denies a request that was settling on $await when an emergency stop ran (fence held: $fence)", async ({ await: name, file, fence }) => {
    const { workspace, sessionId } = await readySession()
    const session = workspace.sessions.find(({ id }) => id === sessionId)!
    session.runtime.permissionMode = "ask"
    session.runtime.auto = false
    const { agent, emit } = agentWithHeldTurns(false)
    const endpoint = await daemonWith(workspace, agent)
    const reader = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    const fencerSocket = sockets.at(-1)!
    const barrier = arm(name)
    try {
      emit(file
        ? { type: "approval-requested", requestId: 88, threadId: "thread-fence", command: "Edit", path: "notes.txt", cwd: session.workspacePath!, reason: "Edit the notes" }
        : { type: "approval-requested", requestId: 88, threadId: "thread-fence", command: "rm -rf build", cwd: session.workspacePath!, reason: "Remove the build output" })
      await barrier.reached
      if (fence) await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({ result: { outcome: "fenced" } })
      await expect(reader("system.emergencyStop", { client: "desktop" })).resolves.toMatchObject({ result: expect.anything() })
    } finally {
      barrier.release()
    }
    if (fence) fencerSocket.terminate()
    await waitForDaemon(() => expect(agent.resolveApproval).toHaveBeenCalledWith(88, "deny"))
    emit({ type: "diff-updated", threadId: "thread-fence", diff: "after the stop" })
    await waitForDaemon(async () => {
      const read = await reader("workspace.get", {})
      expect((read.result as WorkspaceSnapshot).artifacts).toContainEqual(expect.objectContaining({ id: `diff-${sessionId}`, content: "after the stop" }))
    })
    const after = (await reader("workspace.get", {})).result as WorkspaceSnapshot
    expect(after.approvals).toEqual([])
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(88, "allow-once")
    expect(agent.resolveApproval).toHaveBeenCalledOnce()
  })

  // Security review round 11: a request that arrives while a stop runs, and
  // waits in its session's queue behind another request until the stop has
  // finished, is still one the stop overtook. It is denied, never held,
  // replayed, carded or allowed, with or without the fence.
  it.each([
    { fence: true },
    { fence: false },
  ])("denies a request that arrived during a stop and waited in its session's queue (fence held: $fence)", async ({ fence }) => {
    const { workspace, sessionId } = await readySession()
    const session = workspace.sessions.find(({ id }) => id === sessionId)!
    session.runtime.permissionMode = "ask"
    session.runtime.auto = false
    const { agent, emit } = agentWithHeldTurns(false)
    const saveGate = { held: undefined as undefined | { entered: () => void; release: Promise<void> } }
    const endpoint = await daemonWith(workspace, agent, (store) => {
      const saveAsync = store.saveAsync.bind(store)
      store.saveAsync = async (snapshot) => {
        const held = saveGate.held
        if (held) {
          saveGate.held = undefined
          held.entered()
          await held.release
        }
        return saveAsync(snapshot)
      }
      return store
    })
    const reader = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    const fencerSocket = sockets.at(-1)!
    const ahead = arm("cardDirectory")
    let stopSaving!: () => void
    const stopReached = new Promise<void>((resolve) => { stopSaving = resolve })
    let releaseStop!: () => void
    try {
      // A request ahead of it in the same session's queue, held in card
      // construction until the stop is over.
      emit({ type: "approval-requested", requestId: 70, threadId: "thread-fence", command: "rm -rf build", cwd: session.workspacePath!, reason: "Remove the build output" })
      await ahead.reached
      if (fence) await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({ result: { outcome: "fenced" } })
      // The stop is kept running by holding its save of the agent state.
      saveGate.held = { entered: stopSaving, release: new Promise<void>((resolve) => { releaseStop = resolve }) }
      const stopping = reader("system.emergencyStop", { client: "desktop" })
      await stopReached
      emit({ type: "approval-requested", requestId: 71, threadId: "thread-fence", command: "rm -rf dist", cwd: session.workspacePath!, reason: "Remove the dist output" })
      releaseStop()
      await expect(stopping).resolves.toMatchObject({ result: expect.anything() })
    } finally {
      releaseStop?.()
      ahead.release()
    }
    if (fence) fencerSocket.terminate()
    await waitForDaemon(() => expect(agent.resolveApproval).toHaveBeenCalledWith(71, "deny"))
    emit({ type: "diff-updated", threadId: "thread-fence", diff: "after the queue" })
    await waitForDaemon(async () => {
      const read = await reader("workspace.get", {})
      expect((read.result as WorkspaceSnapshot).artifacts).toContainEqual(expect.objectContaining({ id: `diff-${sessionId}`, content: "after the queue" }))
    })
    const after = (await reader("workspace.get", {})).result as WorkspaceSnapshot
    expect(after.approvals).toEqual([])
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(71, "allow-once")
    expect(agent.resolveApproval.mock.calls.filter(([requestId]) => requestId === 71)).toEqual([[71, "deny"]])
    expect(agent.resolveApproval).not.toHaveBeenCalledWith(70, "allow-once")
  })
})

// Holds the first save whose snapshot passes `when`, so a test can keep an
// emergency stop running at its save of the agent state. The daemon passes
// its live snapshot, so `when` reads it as it is at the save.
function heldSaves() {
  let held: undefined | { when: (snapshot: WorkspaceSnapshot) => boolean; entered: () => void; release: Promise<"succeeds" | "fails"> }
  const wrap = (store: SqliteWorkspaceStore) => {
    const saveAsync = store.saveAsync.bind(store)
    store.saveAsync = async (snapshot) => {
      const gate = held
      if (gate?.when(snapshot)) {
        held = undefined
        gate.entered()
        if (await gate.release === "fails") throw new Error("The held save failed")
      }
      return saveAsync(snapshot)
    }
    return store
  }
  const hold = (when: (snapshot: WorkspaceSnapshot) => boolean = () => true) => {
    let entered!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    let release!: (outcome: "succeeds" | "fails") => void
    held = { when, entered, release: new Promise((resolve) => { release = resolve }) }
    return { reached, release }
  }
  return { wrap, hold }
}

// Security review of #577: an emergency stop denies gates and interrupts
// turns before it saves its state. A fence asked for in that gap found nothing
// in flight and was granted, so a handoff could stop the daemon mid-stop.
describe("the service handoff fence and an emergency stop", () => {
  it("refuses a fence while a stop saves its state, after its gates cleared, and grants it once the stop finishes", async () => {
    const { workspace, sessionId } = await readySession()
    const session = workspace.sessions.find(({ id }) => id === sessionId)!
    session.runtime.permissionMode = "ask"
    session.runtime.auto = false
    const { agent, emit } = agentWithHeldTurns(false)
    const saves = heldSaves()
    const endpoint = await daemonWith(workspace, agent, saves.wrap)
    const reader = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    emit({ type: "approval-requested", requestId: 7, threadId: "thread-fence", command: "rm -rf build", cwd: session.workspacePath!, reason: "Remove the build output" })
    await waitForDaemon(async () => {
      const read = (await reader("workspace.get", {})).result as WorkspaceSnapshot
      expect(read.approvals).toMatchObject([{ sessionId, providerRequestId: 7 }])
    })
    // Only the stop's own save is held: it is the one that records the stop.
    const save = saves.hold((snapshot) => snapshot.thread.some((item) => item.kind === "system" && item.body.startsWith("Emergency stop requested")))
    const stopping = reader("system.emergencyStop", { client: "desktop" })
    try {
      await save.reached
      expect(agent.resolveApproval).toHaveBeenCalledWith(7, "deny")
      await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({
        result: { outcome: "refused", refusal: serviceHandoffStopRefusal },
      })
    } finally {
      save.release("succeeds")
    }
    await expect(stopping).resolves.toMatchObject({ result: { failures: [] } })
    await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({ result: { outcome: "fenced" } })
  })

  // The stop's own failure rule: a save that fails is recorded as a
  // persistence failure and the stop still finishes. The fence waits for it
  // to finish, and not longer.
  it("refuses a fence while a stop's save is failing, and grants it once the stop finishes with that failure", async () => {
    const saves = heldSaves()
    const endpoint = await daemonWith(quiet(), undefined, saves.wrap)
    const reader = await desktopConnection(endpoint)
    const fencer = await desktopConnection(endpoint)
    const save = saves.hold()
    const stopping = reader("system.emergencyStop", { client: "desktop" })
    try {
      await save.reached
      await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({
        result: { outcome: "refused", refusal: serviceHandoffStopRefusal },
      })
    } finally {
      save.release("fails")
    }
    await expect(stopping).resolves.toMatchObject({ result: { failures: [expect.objectContaining({ target: "persistence" })] } })
    await expect(fencer("system.serviceHandoffFence", {})).resolves.toMatchObject({ result: { outcome: "fenced" } })
  })

  // #576's design, kept: a stop is never refused, and a fence taken before it
  // began stays held through it and after it, so no turn starts until the
  // holder lets go. The stop denies what the fence held (tests above).
  it("runs a stop to completion under a fence taken before it, and the fence stays held", async () => {
    const { workspace, sessionId } = await readySession()
    const { agent } = agentWithHeldTurns(false)
    const saves = heldSaves()
    const endpoint = await daemonWith(workspace, agent, saves.wrap)
    const reader = await desktopConnection(endpoint)
    const fence = await holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })
    expect(fence).toEqual({ release: expect.any(Function) })
    const save = saves.hold()
    const stopping = reader("system.emergencyStop", { client: "desktop" })
    try {
      await save.reached
      // The stop's own refusal answers first while it runs.
      await expect(reader("session.send", { sessionId, prompt: "go", client: "desktop" })).resolves.toMatchObject({ error: { code: -32602 } })
      await expect(holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })).rejects.toThrow()
    } finally {
      save.release("succeeds")
    }
    await expect(stopping).resolves.toMatchObject({ result: { failures: [] } })
    await expect(reader("session.send", { sessionId, prompt: "go", client: "desktop" })).resolves.toMatchObject({
      error: { code: -32602, message: serviceHandoffFencedMessage },
    })
    expect(agent.startTurn).not.toHaveBeenCalled()
    if ("release" in fence) fence.release()
    await waitForDaemon(async () => {
      const retry = await reader("session.send", { sessionId, prompt: "go", client: "desktop" })
      expect(retry.error).toBeUndefined()
    })
  })

  // Security review of #628: with the fence held, the holder goes on to stop
  // the daemon (the desktop's stopOwned ends in DomovoiDaemon.stop, as the
  // signal handlers do). A shutdown that meets a stop still saving must wait
  // for that save before it closes the store, so the stop's record survives.
  it("waits for a running stop's save before it closes the store, and the stop's record survives a restart", async () => {
    const { workspace, sessionId } = await readySession()
    const statePath = join(await mkdtemp(join(tmpdir(), "domovoi-fence-state-")), "workspace.sqlite")
    scratchDirectories.push(dirname(statePath))
    const order: string[] = []
    const stopRecorded = (snapshot: WorkspaceSnapshot) => snapshot.thread.some((item) => item.kind === "system" && item.body.startsWith("Emergency stop requested"))
    const saves = heldSaves()
    const store = saves.wrap(new SqliteWorkspaceStore(statePath, workspace))
    const saveAsync = store.saveAsync.bind(store)
    store.saveAsync = async (snapshot) => {
      const recorded = stopRecorded(snapshot)
      await saveAsync(snapshot)
      if (recorded) order.push("stop saved")
    }
    const close = store.close.bind(store)
    store.close = async () => { order.push("store closed"); await close() }
    const profileDirectory = await mkdtemp(join(tmpdir(), "domovoi-fence-"))
    scratchDirectories.push(profileDirectory)
    const terminal = {
      process: "bash", write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })), onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const daemon = new DomovoiDaemon({
      port: 0, store, profileDirectory, agents: {},
      skillCatalog: { list: async () => [], read: async () => { throw new Error("No skills here") } },
      terminalService: { spawn: vi.fn(() => terminal) },
    })
    daemons.push(daemon)
    const address = await daemon.start()
    const endpoint = { url: `ws://${address.host}:${address.port}/rpc`, token: daemon.authToken }
    const reader = await desktopConnection(endpoint)
    // An open terminal gives the stop a session to record itself on, and does
    // not refuse the fence.
    await expect(reader("terminal.create", {
      terminalId: "terminal-fence", sessionId, cols: 80, rows: 24, client: "desktop", clientId: "desktop-fence-test",
    })).resolves.toMatchObject({ result: expect.anything() })
    const fence = await holdServiceHandoffFence({ endpoint, timeoutMs: 5_000 })
    expect(fence).toEqual({ release: expect.any(Function) })
    const save = saves.hold(stopRecorded)
    void reader("system.emergencyStop", { client: "desktop" })
    let stopped: Promise<void> | undefined
    try {
      await save.reached
      stopped = daemon.stop()
      // Let the shutdown run as far as it goes without the save.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      save.release("succeeds")
    }
    await stopped
    expect(order).toEqual(["stop saved", "store closed"])
    const reopened = new SqliteWorkspaceStore(statePath, quiet())
    try {
      expect(reopened.load().thread).toContainEqual(expect.objectContaining({
        sessionId, kind: "system", body: "Emergency stop requested by desktop.",
      }))
    } finally {
      await reopened.close()
    }
  })
})

// A narrow text check on the approval-requested handler, not proof. It
// catches a direct `resolveApproval(event.requestId` or `#putApproval(` call
// in that handler that follows an `await` with no `#admitApprovalRequest(`
// call in between, in source order. It does not follow control flow, and it
// does not catch an answer made through an alias (a local holding
// resolveApproval), a helper, or another method, nor answers outside this
// handler. The behaviour tests above, which hold each await and run the fence
// and the stop across it, are the coverage; this only flags the plainest
// regression early.
describe("the approval request handler", () => {
  it("asks the admission check after every await and before every answer or card", async () => {
    const { readFile } = await import("node:fs/promises")
    const source = await readFile(new URL("./server.ts", import.meta.url), "utf8")
    const handler = source.indexOf("async #handleAgentEvent(")
    expect(handler).toBeGreaterThan(0)
    const start = source.indexOf('if (event.type === "approval-requested") {', handler)
    const end = source.indexOf('if (event.type === "item") {', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    // Comments name awaits too; only code counts.
    const branch = source.slice(start, end).split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n")
    const tokens = [...branch.matchAll(/\bawait\b|this\.#admitApprovalRequest\(|resolveApproval\(event\.requestId|this\.#putApproval\(/g)]
      .map((match) => match[0])
    expect(tokens).toContain("this.#admitApprovalRequest(")
    let admitted = false
    const answers: string[] = []
    for (const token of tokens) {
      if (token === "await") admitted = false
      else if (token === "this.#admitApprovalRequest(") admitted = true
      else {
        answers.push(token)
        expect(admitted, `${token} is reached after an await without the admission check`).toBe(true)
      }
    }
    expect(answers.length).toBeGreaterThanOrEqual(4)
  })
})
