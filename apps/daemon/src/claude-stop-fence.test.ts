import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEmptyWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { ClaudeAgentSdkAdapter } from "./claude.js"
import type { ClaudeSpawn } from "./claude-process.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { fakeClaudeChild, fakeClaudePid, spawningClaudeFactory } from "./test-claude-process.js"
import type { WorkspaceService } from "./workspace.js"

// Issue #646, the first probe of the #645 security review. A Claude turn
// whose interrupt fails, and whose process then will not exit, used to be
// saved idle when its project closed: reopening the project and sending again
// resumed a second query in the same worktree while the first still ran.

type RpcReply = {
  result?: Record<string, unknown> & {
    sessions?: Array<{ id: string; state: string }>
    thread?: Array<{ sessionId: string; body?: string }>
  }
  error?: { code: number; message: string; data?: unknown }
}

const runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }
const fence = "Provider thread requires recovery after emergency stop"
const notStopped = "The provider thread did not stop when this project was closed."

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-claude-stop-fence-"))
  // The first Claude process hangs; any later one exits when its stdin ends.
  const children: Array<ReturnType<typeof fakeClaudeChild>> = []
  const spawn: ClaudeSpawn = () => {
    const child = fakeClaudeChild({ exitsOnEof: children.length > 0, pid: fakeClaudePid + children.length })
    children.push(child)
    return child.process
  }
  const kill = vi.fn()
  const { factory, sessions } = spawningClaudeFactory()
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn, kill, platform: "linux", shutdownGraceMs: 20, killGraceMs: 20,
  })
  const checkpoint = vi.fn(async (_path: string, _label: string) => ({ commit: "b".repeat(40), changedFiles: [] }))
  const workspaceService = {
    inspect: async (path: string) => ({ root: path, name: path.split("/").at(-1), branch: "main", head: "a".repeat(40) }),
    createSessionWorkspace: async () => ({ path: scratch, branch: "domovoi/claude", baseCommit: "a".repeat(40) }),
    removeSessionWorkspace: async () => {},
    checkpoint,
    restore: async () => ({ restoredCommit: "b".repeat(40), recoveryCommit: "c".repeat(40) }),
  } as unknown as WorkspaceService
  const daemon = new DomovoiDaemon({
    port: 0,
    store: new SqliteWorkspaceStore(join(scratch, "state.sqlite"), createEmptyWorkspace({
      id: `machine-${"8".repeat(32)}`, name: "claude-stop-fence", platform: process.platform, arch: process.arch,
      version: "0.0.1", connection: "local", reachable: true, providers: [],
    })),
    agents: { "claude-code": adapter },
    workspaceService,
    agentTimeoutMs: 2_000,
    modelCacheTtlMs: 0,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    errorSink: () => {},
  })
  const address = await daemon.start()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  cleanups.push(async () => {
    socket.terminate()
    // The hung process is a double; end it so the daemon can stop.
    for (const child of children) child.exit("SIGKILL")
    await daemon.stop()
    await rm(scratch, { recursive: true, force: true })
  })
  await once(socket, "open")
  let id = 0
  const rpc = (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<RpcReply>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(String(data)) as RpcReply & { id?: number }
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
  expect(await rpc("system.hello", {
    client: "desktop", clientId: "desktop-claude-stop-fence", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).not.toHaveProperty("error")
  const openProject = async (path: string) => {
    const first = await rpc("project.open", { path, client: "desktop" })
    if (!first.error) return first
    return rpc("project.open", { path, client: "desktop", confirmation: first.error.data })
  }
  // A Claude turn runs in project one; its interrupt fails and its process
  // will not exit, so closing the project cannot stop it.
  const hangInProjectOne = async () => {
    await openProject("/code/one")
    const created = await rpc("session.create", { title: "One", runtime, client: "desktop" })
    expect(created.error).toBeUndefined()
    const sessionId = created.result?.activeSessionId as string
    expect(await rpc("session.send", { sessionId, prompt: "first", client: "desktop" })).not.toHaveProperty("error")
    expect(sessions()).toHaveLength(1)
    sessions()[0]!.interrupt.mockRejectedValue(new Error("Claude did not answer the interrupt"))
    expect((await openProject("/code/two")).error).toBeUndefined()
    const back = await openProject("/code/one")
    expect(back.error).toBeUndefined()
    return { sessionId, back }
  }
  // A Claude turn runs; its interrupt fails and its process will not exit.
  const hangTurn = async () => {
    await openProject("/code/one")
    const created = await rpc("session.create", { title: "One", runtime, client: "desktop" })
    expect(created.error).toBeUndefined()
    const sessionId = created.result?.activeSessionId as string
    expect(await rpc("session.send", { sessionId, prompt: "first", client: "desktop" })).not.toHaveProperty("error")
    sessions()[0]!.interrupt.mockRejectedValue(new Error("Claude did not answer the interrupt"))
    return sessionId
  }
  return { rpc, sessions, children, kill, checkpoint, hangInProjectOne, hangTurn }
}

describe("a Claude process that will not stop", () => {
  it("leaves its session failed and fenced across a project switch, with no second query", async () => {
    const { rpc, sessions, children, kill, hangInProjectOne } = await fixture()

    const { sessionId, back } = await hangInProjectOne()

    expect(back.result?.sessions?.find(({ id }) => id === sessionId)).toMatchObject({ state: "failed" })
    expect(back.result?.thread?.filter((item) => item.sessionId === sessionId).map(({ body }) => body))
      .toContain(notStopped)
    expect(kill).toHaveBeenCalledWith(-fakeClaudePid, "SIGKILL")

    const again = await rpc("session.send", { sessionId, prompt: "again", client: "desktop" })
    expect(again.error?.message).toBe(fence)
    expect(sessions()).toHaveLength(1)
    expect(children[0]!.child.exitCode).toBeNull()
    expect(children[0]!.child.signalCode).toBeNull()
  })

  it("keeps the fence through recovery while the process lives, and lifts it once it has exited", async () => {
    const { rpc, children, hangInProjectOne } = await fixture()
    const { sessionId } = await hangInProjectOne()

    const refused = await rpc("session.setRuntime", { sessionId, client: "desktop", runtime })
    expect(refused.error).toBeDefined()
    expect((await rpc("session.send", { sessionId, prompt: "again", client: "desktop" })).error?.message)
      .toBe(fence)

    children[0]!.exit("SIGKILL")
    const recovered = await rpc("session.setRuntime", { sessionId, client: "desktop", runtime })
    expect(recovered.error).toBeUndefined()
    expect(await rpc("session.send", { sessionId, prompt: "again", client: "desktop" })).not.toHaveProperty("error")
  })

  // Security review round 1 of #647, F1: recovery started its replacement
  // query, and took its checkpoint, before it tried to stop the failed one.
  it("starts no replacement query and takes no checkpoint while recovery cannot stop the failed process", async () => {
    const { rpc, sessions, children, checkpoint, hangInProjectOne } = await fixture()
    const { sessionId } = await hangInProjectOne()
    const checkpointsBefore = checkpoint.mock.calls.length

    const refused = await rpc("session.setRuntime", { sessionId, client: "desktop", runtime })
    expect(refused.error).toBeDefined()
    expect(sessions()).toHaveLength(1)
    expect(checkpoint).toHaveBeenCalledTimes(checkpointsBefore)
    expect((await rpc("session.send", { sessionId, prompt: "again", client: "desktop" })).error?.message)
      .toBe(fence)

    children[0]!.exit("SIGKILL")
    expect((await rpc("session.setRuntime", { sessionId, client: "desktop", runtime })).error).toBeUndefined()
    expect(sessions()).toHaveLength(2)
    expect(checkpoint).toHaveBeenCalledTimes(checkpointsBefore + 1)
  })

  // F6: a second emergency stop left out the thread the first could not
  // stop, and reported no failure while its process still ran.
  it("reports the failed stop again on each emergency stop until the process exits, and keeps the fence", async () => {
    const { rpc, sessions, children, hangTurn } = await fixture()
    const sessionId = await hangTurn()
    type Stop = { failures: Array<{ target: string; message: string }> }

    const first = (await rpc("system.emergencyStop", { client: "desktop" })).result as unknown as Stop
    expect(first.failures).toContainEqual(expect.objectContaining({ target: "turn" }))

    const second = (await rpc("system.emergencyStop", { client: "desktop" })).result as unknown as Stop
    expect(second.failures).toContainEqual({
      target: "provider",
      targetId: expect.any(String),
      message: expect.stringContaining("did not exit"),
    })
    expect(children[0]!.child.exitCode).toBeNull()
    expect(children[0]!.child.signalCode).toBeNull()
    expect((await rpc("session.send", { sessionId, prompt: "again", client: "desktop" })).error?.message)
      .toBe(fence)

    children[0]!.exit("SIGKILL")
    const third = (await rpc("system.emergencyStop", { client: "desktop" })).result as unknown as Stop
    expect(third.failures).toEqual([])
    expect((await rpc("session.send", { sessionId, prompt: "again", client: "desktop" })).error?.message)
      .toBe(fence)
    expect(sessions()).toHaveLength(1)
  })
})
