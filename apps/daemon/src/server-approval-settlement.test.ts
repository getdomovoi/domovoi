import * as fs from "node:fs"
import { once } from "node:events"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { realPathLookupBudgetMs } from "./credential-stores.js"
import { resolveExecution } from "./execution-resolution.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

// Every approval the daemon holds, saves or sends is judged the same way: the
// directory as written and at its real path, every operand of the command and
// of its current execution, and every path in the execution record, under one
// deadline for the whole request.

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

type Approval = WorkspaceSnapshot["approvals"][number]

function rpc(socket: WebSocket, method: string, params: Record<string, unknown> = {}) {
  const id = ++requestId
  return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No response for ${method}`)) }, 4_000)
    const cleanup = () => { clearTimeout(timer); socket.off("message", receive) }
    const receive = (bytes: WebSocket.RawData) => {
      const result = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { code: number; message: string } }
      if (result.id === id) { cleanup(); resolve(result) }
    }
    socket.on("message", receive)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function setup(
  files: (directory: string) => Promise<void> = async () => {},
  rules: (directory: string) => Promise<WorkspaceSnapshot["approvalRules"]> = async () => [],
  options: {
    // Cards saved before the daemon starts.
    saved?: (directory: string) => Approval[]
    // Load the snapshot object itself, so the test holds the live copy.
    live?: boolean
  } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "domovoi-settle-")))
  roots.push(directory)
  await writeFile(join(directory, "notes.txt"), "")
  await writeFile(join(directory, ".env"), "")
  await files(directory)
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = directory
  session.providerThreadId = "thread-settle"
  delete session.activeTurnId
  snapshot.approvals = options.saved?.(directory) ?? []
  snapshot.approvalRules = await rules(directory)
  let listener: ((event: AgentEvent) => void) | undefined
  const agent = {
    permissionCapabilities: { ask: "read-only", buildAuto: "pre-execution" },
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "thread-settle"), resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "turn-settle"),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}), resolveApproval: vi.fn(),
    onEvent: (next: (event: AgentEvent) => void) => { listener = next; return () => { listener = undefined } },
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const stateDirectory = await mkdtemp(join(tmpdir(), "domovoi-settle-state-"))
  roots.push(stateDirectory)
  const store = new SqliteWorkspaceStore(join(stateDirectory, "state.sqlite"), snapshot)
  const errorSink = vi.fn()
  const daemon = new DomovoiDaemon({
    port: 0,
    store: options.live ? { load: () => snapshot, save: vi.fn(), close: vi.fn() } : store,
    agents: { "claude-code": agent },
    errorSink,
  })
  daemons.push(daemon)
  const address = await daemon.start()
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const hello = await rpc(socket, "system.hello", { client: "cli", clientId: "settle-owner", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })
  expect(hello.error).toBeUndefined()
  expect((await rpc(socket, "session.send", { sessionId: session.id, prompt: "Work", client: "cli" })).error).toBeUndefined()
  const notices: string[] = []
  socket.on("message", (bytes) => {
    const text = bytes.toString()
    if ((JSON.parse(text) as { method?: string }).method === "workspace.changed") notices.push(text)
  })
  const emit = (event: { requestId: number; command: string; reason?: string; cwd?: string; path?: string }) => listener!({
    type: "approval-requested",
    threadId: "thread-settle",
    turnId: "turn-settle",
    reason: event.reason ?? "Run a command",
    cwd: event.cwd ?? directory,
    ...event,
  })
  const card = async (id: number): Promise<Approval | undefined> => (
    (await rpc(socket, "workspace.get")).result as WorkspaceSnapshot
  ).approvals.find((approval) => approval.providerRequestId === id)
  return { directory, socket, store, agent, emit, card, notices, errorSink, snapshot }
}

// A card as a daemon from before this check saved it: its directory is an
// ordinary name, and only its real path is a store.
function savedCard(directory: string, providerRequestId: number): Approval {
  return {
    id: `approval-saved-${providerRequestId}`,
    sessionId: demoWorkspace.sessions[0]!.id,
    risk: "normal",
    operation: "List files",
    command: "ls",
    machine: "macbook-pro-m3",
    agent: "claude-code / sonnet",
    mode: "build",
    directory,
    affects: "Anything this user account can reach on this machine.",
    network: "Not restricted: this provider runs commands with this machine's network access.",
    estimatedDuration: "Unknown",
    checkpoint: "unavailable",
    providerRequestId,
    requestedAt: "2026-09-24T00:00:00.000Z",
    execution: { state: "unresolved", reason: "unsupported-syntax" },
  }
}

describe("approval settlement", () => {
  // Finding 1: deep-link/.. is the store's directory, since the filesystem
  // follows deep-link before it applies the "..".
  it("judges a directory written through a link before its '..' at its real location, live and saved", async () => {
    const { directory, emit, card, store } = await setup(async (root) => {
      await mkdir(join(root, ".aws", "deep"), { recursive: true })
      await symlink(join(root, ".aws", "deep"), join(root, "deep-link"))
    })
    emit({ requestId: 11, command: "cat notes.txt", reason: "Read a file", cwd: `${directory}${sep}deep-link${sep}..` })
    const live = await waitForDaemon(async () => {
      const approval = await card(11)
      expect(approval).toBeDefined()
      return approval!
    })
    expect(live).toMatchObject({ risk: "hard-gate", directory: "[REDACTED] in the session worktree" })
    expect(JSON.stringify(live)).not.toMatch(/deep-link|\.aws/)
    const saved = store.load().approvals.find((approval) => approval.providerRequestId === 11)
    expect(saved).toMatchObject({ risk: "hard-gate", directory: "[REDACTED] in the session worktree" })
    expect(JSON.stringify(saved)).not.toMatch(/deep-link|\.aws/)
  })

  // Finding 2: the operands at Allow come from the execution the card now
  // holds, not from the one it was made with.
  it("classifies the operands of a package script that changed while the card waited", async () => {
    const { directory, socket, emit, card, agent } = await setup(async (root) => {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { show: "cat notes.txt" } }))
      await symlink(join(root, ".env"), join(root, "link.txt"))
    })
    emit({ requestId: 21, command: "pnpm run show" })
    const waiting = await waitForDaemon(async () => {
      const approval = await card(21)
      expect(approval).toMatchObject({ risk: "normal" })
      return approval!
    })
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { show: "cat link.txt" } }))
    await expect(rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "allow-once", client: "cli" }))
      .resolves.toMatchObject({ error: { message: "The file target changed; review the updated approval before allowing it" } })
    expect(await card(21)).toMatchObject({ id: waiting.id, risk: "hard-gate" })
    await expect(rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "always-project", client: "cli" }))
      .resolves.toMatchObject({ error: { message: "Hard-gate approvals cannot create standing rules" } })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  it("lets no standing rule allow a request whose script reads a link into a secret", async () => {
    const { emit, card, agent } = await setup(async (root) => {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { show: "cat link.txt" } }))
      await symlink(join(root, ".env"), join(root, "link.txt"))
    }, async (root) => {
      const execution = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm run show" })
      if (execution.state !== "resolved") throw new Error("Fixture command was not resolved")
      return [{
        id: "rule-show", projectId: demoWorkspace.project!.id, operation: "Run a command", command: "pnpm run show",
        status: "active", execution, createdBy: "desktop", createdAt: "2026-09-01T00:00:00.000Z", useCount: 0,
      }]
    })
    emit({ requestId: 22, command: "pnpm run show" })
    await waitForDaemon(async () => expect(await card(22)).toMatchObject({ risk: "hard-gate" }))
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  // Finding 3: one deadline covers the execution lookup and every real path
  // behind the card, and a lookup that does not finish fails closed.
  it("makes a card within one lookup budget when every real path lookup stalls, and fails closed", async () => {
    const { emit, card } = await setup()
    vi.spyOn(fs.realpath, "native").mockImplementation((() => {}) as never)
    const bound = realPathLookupBudgetMs + 1_500
    for (const id of [31, 32]) {
      const started = performance.now()
      emit({ requestId: id, command: "cat notes.txt", reason: "Read a file", path: "notes.txt" })
      const approval = await vi.waitFor(async () => {
        const found = await card(id)
        expect(found).toBeDefined()
        return found!
      }, { timeout: 3_500, interval: 50 })
      expect(performance.now() - started).toBeLessThan(bound)
      expect(approval).toMatchObject({
        risk: "hard-gate",
        directory: "[REDACTED] in the session worktree",
        affects: "The file [REDACTED] in the session worktree.",
        execution: { state: "unresolved", reason: "sensitive-content" },
      })
    }
  })

  // Finding 4: a manifest reached through a link into a store names the
  // store in the execution record. The card is a hard gate, and the record is
  // hidden in every copy, on a new card and on one refreshed at Allow.
  it("hard-gates a new card whose package manifest is a link into a store, and hides the record", async () => {
    const { emit, card, agent, notices } = await setup(async (root) => {
      await mkdir(join(root, ".aws"))
      await writeFile(join(root, ".aws", "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))
      await symlink(join(root, ".aws", "package.json"), join(root, "package.json"))
    })
    emit({ requestId: 41, command: "pnpm test" })
    const approval = await waitForDaemon(async () => {
      const found = await card(41)
      expect(found).toBeDefined()
      return found!
    })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
    expect(approval).toMatchObject({ risk: "hard-gate", execution: { state: "unresolved", reason: "sensitive-content" } })
    expect(JSON.stringify(approval)).not.toContain(".aws")
    expect(notices.join("\n")).not.toContain(".aws")
  })

  it("hides a refreshed execution record whose manifest moved into a store, and refuses the Allow", async () => {
    const { directory, socket, emit, card, agent, notices } = await setup(async (root) => {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { show: "cat notes.txt" } }))
      await mkdir(join(root, ".aws"))
      await writeFile(join(root, ".aws", "package.json"), JSON.stringify({ scripts: { show: "cat notes.txt --number" } }))
    })
    emit({ requestId: 42, command: "pnpm run show" })
    const waiting = await waitForDaemon(async () => {
      const found = await card(42)
      expect(found).toMatchObject({ risk: "normal", execution: { state: "resolved" } })
      return found!
    })
    await rm(join(directory, "package.json"))
    await symlink(join(directory, ".aws", "package.json"), join(directory, "package.json"))
    const sent = notices.length
    const answer = await rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "allow-once", client: "cli" })
    const refreshed = await card(42)
    expect(notices.slice(sent).join("\n")).not.toContain(".aws")
    expect(JSON.stringify(refreshed)).not.toContain(".aws")
    expect(refreshed).toMatchObject({ id: waiting.id, risk: "hard-gate", execution: { state: "unresolved", reason: "sensitive-content" } })
    expect(answer).toMatchObject({ error: { message: "The file target changed; review the updated approval before allowing it" } })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  // Load: a card read back from disk goes through the same settlement, at the
  // real paths on disk now, before any client sees it.
  it("settles a saved card when the daemon starts, at the real path of its directory", async () => {
    const { card, store } = await setup(async (root) => {
      await mkdir(join(root, ".aws"))
      await symlink(join(root, ".aws"), join(root, "plain"))
    }, undefined, { saved: (root) => [savedCard(join(root, "plain"), 51)] })
    const loaded = await card(51)
    expect(loaded).toMatchObject({ risk: "hard-gate", directory: "[REDACTED] in the session worktree" })
    expect(JSON.stringify(loaded)).not.toContain("plain")
    expect(JSON.stringify(store.load().approvals)).not.toContain("plain")
  })

  // Every save and broadcast checks the live list against what settlement
  // produced: an approval changed in place is sealed, not sent as it is.
  it("seals an approval written into the snapshot without settlement", async () => {
    const { directory, snapshot, emit, card, errorSink } = await setup(undefined, undefined, {
      live: true,
      saved: (root) => [savedCard(root, 61)],
    })
    expect(await card(61)).toMatchObject({ risk: "normal", directory })
    const live = snapshot.approvals.find((approval) => approval.providerRequestId === 61)!
    live.directory = join(directory, ".aws")
    emit({ requestId: 62, command: "ls" })
    await waitForDaemon(async () => expect(await card(62)).toBeDefined())
    expect(await card(61)).toMatchObject({
      risk: "hard-gate",
      directory: "[REDACTED] in the session worktree",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
    expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
      context: "Domovoi sealed an approval that did not pass its path checks",
    }))
  })

  // A saved card names its file only in its file line. That file is judged on
  // disk at load and again at Allow.
  function savedFileCard(directory: string, providerRequestId: number): Approval {
    return {
      ...savedCard(directory, providerRequestId),
      operation: "Edit a file",
      command: "Command details unavailable",
      affects: "The file notes.txt in the session worktree.",
    }
  }

  it("settles a saved card at the real path of its file when the daemon starts", async () => {
    const { card, store } = await setup(async (root) => {
      await mkdir(join(root, ".aws"))
      await writeFile(join(root, ".aws", "credentials"), "")
      await rm(join(root, "notes.txt"))
      await symlink(join(root, ".aws", "credentials"), join(root, "notes.txt"))
    }, undefined, { saved: (root) => [savedFileCard(root, 71)] })
    expect(await card(71)).toMatchObject({ risk: "hard-gate", affects: "The file [REDACTED] in the session worktree." })
    expect(store.load().approvals.find((approval) => approval.providerRequestId === 71))
      .toMatchObject({ risk: "hard-gate", affects: "The file [REDACTED] in the session worktree." })
  })

  it("refuses the Allow of a saved card whose file became a link into a store", async () => {
    const { directory, socket, card, agent } = await setup(undefined, undefined, { saved: (root) => [savedFileCard(root, 72)] })
    const loaded = await card(72)
    expect(loaded).toMatchObject({ risk: "normal", affects: "The file notes.txt in the session worktree." })
    await mkdir(join(directory, ".aws"))
    await writeFile(join(directory, ".aws", "credentials"), "")
    await rm(join(directory, "notes.txt"))
    await symlink(join(directory, ".aws", "credentials"), join(directory, "notes.txt"))
    await expect(rpc(socket, "approval.resolve", { approvalId: loaded!.id, decision: "allow-once", client: "cli" }))
      .resolves.toMatchObject({ error: { message: "The file target changed; review the updated approval before allowing it" } })
    expect(await card(72)).toMatchObject({ risk: "hard-gate", affects: "The file [REDACTED] in the session worktree." })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  it("sends no path from a changed file line in another format", async () => {
    const { directory, snapshot, emit, card, notices } = await setup(undefined, undefined, {
      live: true,
      saved: (root) => [savedCard(root, 73)],
    })
    expect(await card(73)).toMatchObject({ risk: "normal" })
    const live = snapshot.approvals.find((approval) => approval.providerRequestId === 73)!
    live.affects = `Reads ${join(directory, ".aws", "credentials")} when it runs.`
    const sent = notices.length
    emit({ requestId: 74, command: "ls" })
    await waitForDaemon(async () => expect(await card(74)).toBeDefined())
    expect(notices.length).toBeGreaterThan(sent)
    expect(notices.slice(sent).join("\n")).not.toContain(".aws")
    const sealed = await card(73)
    expect(sealed).toMatchObject({ risk: "hard-gate" })
    expect(sealed!.affects).not.toContain(".aws")
  })
})
