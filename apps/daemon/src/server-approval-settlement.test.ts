import * as fs from "node:fs"
import { once } from "node:events"
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, executionRecordSchema, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { unrestrictedApprovalScope } from "./approval-facts.js"
import { savedSettlementInput, settleApproval } from "./approval-settlement.js"
import type { AgentAdapter, AgentEvent } from "./codex.js"
import { realPathLookupBudgetMs } from "./credential-stores.js"
import { fileScopedTools, resolveCommandExecution, resolveExecution } from "./execution-resolution.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import {
  cardCommand,
  cardOperation,
  cardTextControls,
  cardTextFailures,
  createHiddenFile,
  hiddenNamePaths,
  hiddenNameRun,
} from "./test-hidden-names.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"
import type { WorkspaceService } from "./workspace.js"

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

// A person's allow takes a snapshot checkpoint before the decision is saved
// (J34), so these gates need a worktree that can take one.
function checkpointingWorkspace(): WorkspaceService {
  return {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(), checkpoint: vi.fn(),
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
  }
}

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
    // Load the snapshot object itself, so the test holds the live copy.
    live?: boolean
    // Keep the worktree path as the temporary directory gave it, which can be
    // a link away from its real path (macOS /var is /private/var).
    asGiven?: boolean
  } = {},
) {
  const created = await mkdtemp(join(tmpdir(), "domovoi-settle-"))
  const directory = options.asGiven ? created : await realpath(created)
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
  // Saved cards expire when the daemon starts (ruled 2026-09-24, #604), so
  // every card here is raised live.
  snapshot.approvals = []
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
  // A live test hands the daemon the snapshot itself, so the SQLite store goes
  // unused; it is closed here, or Windows refuses to delete its open file.
  if (options.live) store.close()
  const errorSink = vi.fn()
  const daemon = new DomovoiDaemon({
    port: 0,
    store: options.live ? { load: () => snapshot, save: vi.fn(), close: vi.fn() } : store,
    agents: { "claude-code": agent },
    workspaceService: checkpointingWorkspace(),
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
  const emit = (event: { requestId: number; command: string; reason?: string; cwd?: string; path?: string; blockedPath?: string }) => listener!({
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
// ordinary name, and only its real path is a store. Its record is the one a
// daemon resolves for "ls" at the worktree root. A saved record is resolved
// again at load, so a card saved at the root keeps it. A card saved in another
// directory, such as a link inside the worktree, resolves to a different
// record there, and that alone makes it a hard gate; the load test checks the
// directory line for what the path check adds.
function savedCard(directory: string, providerRequestId: number): Approval {
  return {
    id: `approval-saved-${providerRequestId}`,
    revision: 0,
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
    execution: resolveCommandExecution({ command: "ls" }),
  }
}

// A worktree with the files setup writes, for settling a saved card's text
// directly, without a daemon: saved cards expire when the daemon starts
// (ruled 2026-09-24, #604).
async function savedRoot(files: (directory: string) => Promise<void> = async () => {}): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "domovoi-settle-")))
  roots.push(directory)
  await writeFile(join(directory, "notes.txt"), "")
  await writeFile(join(directory, ".env"), "")
  await files(directory)
  return directory
}

// Each card settled from its saved text, as the daemon settles a card it
// holds no request for (savedSettlementInput), by provider request id.
async function settleSaved(cards: readonly Approval[], root: string): Promise<Map<number, Approval>> {
  const settled = new Map<number, Approval>()
  for (const saved of cards) {
    const { approval } = await settleApproval(savedSettlementInput(saved, root, undefined, () => saved.risk))
    settled.set(saved.providerRequestId!, approval)
  }
  return settled
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
    await expect(rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "allow-once", revision: waiting.revision, client: "cli" }))
      .resolves.toMatchObject({ error: { message: "The file target changed; review the updated approval before allowing it" } })
    const rewritten = await card(21)
    expect(rewritten).toMatchObject({ id: waiting.id, risk: "hard-gate", revision: waiting.revision + 1 })
    await expect(rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "always-project", revision: rewritten!.revision, client: "cli" }))
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
    const answer = await rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "allow-once", revision: waiting.revision, client: "cli" })
    const refreshed = await card(42)
    expect(notices.slice(sent).join("\n")).not.toContain(".aws")
    expect(JSON.stringify(refreshed)).not.toContain(".aws")
    expect(refreshed).toMatchObject({ id: waiting.id, risk: "hard-gate", execution: { state: "unresolved", reason: "sensitive-content" } })
    expect(answer).toMatchObject({ error: { message: "The file target changed; review the updated approval before allowing it" } })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  // Saved cards expire when the daemon starts (ruled 2026-09-24, #604). What
  // the load tests protected is checked on a live card settled again before an
  // Allow, and on a saved card's text settled through savedSettlementInput,
  // the path a card without a held request still takes.
  it("settles a card again before an Allow, at the real path of its directory", async () => {
    const { directory, socket, emit, card, store, agent } = await setup(async (root) => {
      await mkdir(join(root, ".aws"))
      await mkdir(join(root, "plain"))
    })
    emit({ requestId: 51, command: "ls", reason: "List files", cwd: join(directory, "plain") })
    const waiting = await waitForDaemon(async () => {
      const found = await card(51)
      expect(found).toMatchObject({ risk: "normal", directory: join(directory, "plain") })
      return found!
    })
    await rm(join(directory, "plain"), { recursive: true })
    await symlink(join(directory, ".aws"), join(directory, "plain"))
    await expect(rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "allow-once", revision: waiting.revision, client: "cli" }))
      .resolves.toMatchObject({ error: { message: "The file target changed; review the updated approval before allowing it" } })
    const settled = await card(51)
    expect(settled).toMatchObject({ risk: "hard-gate", directory: "[REDACTED] in the session worktree", revision: waiting.revision + 1 })
    expect(JSON.stringify(settled)).not.toContain("plain")
    expect(JSON.stringify(store.load().approvals)).not.toContain("plain")
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  // Every save and broadcast checks the live list against what settlement
  // produced: an approval changed in place is sealed, not sent as it is.
  it("seals an approval written into the snapshot without settlement", async () => {
    const { directory, snapshot, emit, card, errorSink } = await setup(undefined, undefined, { live: true })
    emit({ requestId: 61, command: "ls", reason: "List files" })
    await waitForDaemon(async () => expect(await card(61)).toMatchObject({ risk: "normal", directory }))
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

  it("settles a new file card at the real path of its file", async () => {
    const { emit, card, store } = await setup(async (root) => {
      await mkdir(join(root, ".aws"))
      await writeFile(join(root, ".aws", "credentials"), "")
      await rm(join(root, "notes.txt"))
      await symlink(join(root, ".aws", "credentials"), join(root, "notes.txt"))
    })
    emit({ requestId: 71, command: "Edit", reason: "Edit a file", path: "notes.txt" })
    const hidden = { risk: "hard-gate", affects: "The file [REDACTED] in the session worktree." }
    await waitForDaemon(async () => expect(await card(71)).toMatchObject(hidden))
    expect(store.load().approvals.find((approval) => approval.providerRequestId === 71)).toMatchObject(hidden)
  })

  it("refuses the Allow of a waiting file card whose file became a link into a store", async () => {
    const { directory, socket, emit, card, agent } = await setup()
    emit({ requestId: 72, command: "Edit", reason: "Edit a file", path: "notes.txt" })
    const waiting = await waitForDaemon(async () => {
      const found = await card(72)
      expect(found).toMatchObject({ risk: "normal", affects: "The file notes.txt in the session worktree." })
      return found!
    })
    await mkdir(join(directory, ".aws"))
    await writeFile(join(directory, ".aws", "credentials"), "")
    await rm(join(directory, "notes.txt"))
    await symlink(join(directory, ".aws", "credentials"), join(directory, "notes.txt"))
    await expect(rpc(socket, "approval.resolve", { approvalId: waiting.id, decision: "allow-once", revision: waiting.revision, client: "cli" }))
      .resolves.toMatchObject({ error: { message: "The file target changed; review the updated approval before allowing it" } })
    expect(await card(72)).toMatchObject({ risk: "hard-gate", affects: "The file [REDACTED] in the session worktree." })
    expect(agent.resolveApproval).not.toHaveBeenCalled()
  })

  it("sends no path from a changed file line in another format", async () => {
    const { directory, snapshot, emit, card, notices } = await setup(undefined, undefined, { live: true })
    emit({ requestId: 73, command: "ls", reason: "List files" })
    await waitForDaemon(async () => expect(await card(73)).toMatchObject({ risk: "normal" }))
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

  // A saved card names its file only in its file line. That file is judged on
  // disk at load and again at Allow. The request gave no command, so its
  // record says so.
  function savedFileCard(directory: string, providerRequestId: number): Approval {
    return {
      ...savedCard(directory, providerRequestId),
      operation: "Edit a file",
      command: "Command details unavailable",
      affects: "The file notes.txt in the session worktree.",
      execution: { state: "unresolved", reason: "command-missing" },
    }
  }

  // A saved file line is read back only when it parses one way into the three
  // forms a card writes, and that parse renders back to the same line. A file
  // name that holds a form's own wording could be read as other paths, so the
  // card is sealed rather than judged at the wrong path.
  const formWording = [
    " in the session worktree.",
    ", outside the session worktree.",
    ", outside the session worktree, through a link at ",
  ]

  type WordedLine = { id: number; affects: string; path: (root: string, outside: string) => string }

  // Each form with each wording in a file name: the file in the worktree, a
  // file outside it, and a link in the worktree that leads outside. path is
  // where that name sits on disk.
  function wordedLines(outside: string): WordedLine[] {
    return formWording.flatMap((wording, index) => {
      const name = (form: string) => `tricky-${form}-${index}${wording}end`
      return [
        { id: 80 + index, affects: `The file ${name("in")} in the session worktree.`, path: (root) => join(root, name("in")) },
        {
          id: 83 + index,
          affects: `The file ${join(outside, name("out"))}, outside the session worktree.`,
          path: (_, away) => join(away, name("out")),
        },
        {
          id: 86 + index,
          affects: `The file ${join(outside, "plain.txt")}, outside the session worktree, through a link at ${name("link")}.`,
          path: (root) => join(root, name("link")),
        },
      ]
    })
  }

  // The same three forms with ordinary names, which read back as they are.
  function plainLines(outside: string): { id: number; affects: string }[] {
    return [
      { id: 90, affects: "The file notes.txt in the session worktree." },
      { id: 91, affects: `The file ${join(outside, "plain.txt")}, outside the session worktree.` },
      { id: 92, affects: `The file ${join(outside, "plain.txt")}, outside the session worktree, through a link at plain-link.` },
    ]
  }

  async function outsideDirectory(): Promise<string> {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "domovoi-settle-outside-")))
    roots.push(outside)
    await writeFile(join(outside, "plain.txt"), "")
    return outside
  }

  // A plain line reads back as it is. A saved Windows path whose "\" is
  // followed by n, r, t or u reads as an escaped control character, so its
  // line is sealed rather than judged at a guessed path (a stated limit): the
  // Windows runner's temporary directory holds "\runneradmin".
  function plainLineSettled(affects: string): Partial<Approval> {
    return /\\(?:[nrt]|u[0-9a-f]{4})/u.test(affects)
      ? { risk: "hard-gate", affects: "The file [REDACTED], outside the session worktree." }
      : { risk: "normal", affects }
  }

  function wordedCards(root: string, outside: string): Approval[] {
    return [...wordedLines(outside), ...plainLines(outside)]
      .map((line) => ({ ...savedFileCard(root, line.id), affects: line.affects }))
  }

  function expectSealed(settled: Map<number, Approval>, outside: string) {
    for (const line of wordedLines(outside)) {
      const loaded = settled.get(line.id)
      expect(loaded, line.affects).toMatchObject({ risk: "hard-gate" })
      expect(loaded!.affects, line.affects).toMatch(/^The file \[REDACTED\](?: in the session worktree|, outside the session worktree)\.$/u)
      expect(JSON.stringify(loaded), line.affects).not.toContain("tricky")
    }
  }

  it("seals a saved file line whose file name holds the line's own wording", async () => {
    const outside = await outsideDirectory()
    const root = await savedRoot(async (root) => {
      await symlink(join(outside, "plain.txt"), join(root, "plain-link"))
      for (const line of wordedLines(outside)) {
        const path = line.path(root, outside)
        if (line.id >= 86) await symlink(join(outside, "plain.txt"), path)
        else await writeFile(path, "")
      }
    })
    const settled = await settleSaved(wordedCards(root, outside), root)
    expectSealed(settled, outside)
    for (const line of plainLines(outside)) {
      expect(settled.get(line.id), line.affects).toMatchObject(plainLineSettled(line.affects))
    }
  })

  it("seals a saved file line whose worded file name became a link into a credential file", async () => {
    const outside = await outsideDirectory()
    const root = await savedRoot(async (root) => {
      await mkdir(join(root, ".aws"))
      await writeFile(join(root, ".aws", "credentials"), "")
      await symlink(join(outside, "plain.txt"), join(root, "plain-link"))
      for (const line of wordedLines(outside)) await symlink(join(root, ".aws", "credentials"), line.path(root, outside))
    })
    const settled = await settleSaved(wordedCards(root, outside), root)
    expectSealed(settled, outside)
    for (const line of plainLines(outside)) {
      expect(settled.get(line.id), line.affects).toMatchObject(plainLineSettled(line.affects))
    }
  })
})

// Owner ruling, late 2026-09-24: a path the card hides is replaced in the
// card's operation and command lines wherever the card's text goes, and only
// that path; an ordinary card keeps the agent's text.
describe("a card's own text when the card hides a path", () => {
  const command = "cat ~/.aws/credentials"
  const reason = "Read ~/.aws/credentials"
  const leak = /~\/\.aws|\.aws\/credentials/u
  const hidden = { risk: "hard-gate", command: "cat [REDACTED]", operation: "Read [REDACTED]" }

  it("shows [REDACTED] for the path in workspace.get, workspace.changed, the store, the receipt and the audit log", async () => {
    const { socket, emit, card, store, notices } = await setup()
    const sent = notices.length
    emit({ requestId: 301, command, reason })
    emit({ requestId: 302, command: "cat notes.txt", reason: "Read notes.txt" })
    const secret = await waitForDaemon(async () => {
      const found = await card(301)
      expect(found).toBeDefined()
      return found!
    })
    const ordinary = await waitForDaemon(async () => {
      const found = await card(302)
      expect(found).toBeDefined()
      return found!
    })
    expect(secret).toMatchObject(hidden)
    expect(JSON.stringify(secret)).not.toMatch(leak)
    expect(ordinary).toMatchObject({ command: "cat notes.txt", operation: "Read notes.txt" })

    const changed = notices.slice(sent).join("\n")
    expect(changed).toContain("cat [REDACTED]")
    expect(changed).not.toMatch(leak)
    const saved = store.load().approvals
    expect(saved.find((approval) => approval.providerRequestId === 301)).toMatchObject(hidden)
    expect(saved.find((approval) => approval.providerRequestId === 302))
      .toMatchObject({ command: "cat notes.txt", operation: "Read notes.txt" })

    expect((await rpc(socket, "approval.resolve", { approvalId: secret.id, decision: "deny", client: "cli" })).error).toBeUndefined()
    const thread = ((await rpc(socket, "workspace.get")).result as WorkspaceSnapshot).thread
    expect(thread.find((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${secret.id}-`)))
      .toMatchObject({ operation: "Read [REDACTED]" })
    expect(JSON.stringify(store.load())).not.toMatch(leak)
    expect(notices.join("\n")).not.toMatch(leak)
    const audit = store.auditLog.query({ limit: 100 }).entries
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining(["provider.approval-requested", "approval.resolve"]))
    expect(JSON.stringify(audit)).not.toMatch(leak)
  })

  it("shows [REDACTED] for the path on a saved card's text settled again", async () => {
    const root = await savedRoot()
    const settled = await settleSaved([{ ...savedCard(root, 311), command, operation: reason }, savedCard(root, 312)], root)
    expect(settled.get(311)).toMatchObject(hidden)
    expect(settled.get(312)).toMatchObject({ command: "ls", operation: "List files" })
    expect(JSON.stringify([...settled.values()])).not.toMatch(leak)
  })

  it("shows [REDACTED] for the path on a card sealed when its lookups stall", async () => {
    const { emit, card } = await setup()
    vi.spyOn(fs.realpath, "native").mockImplementation((() => {}) as never)
    emit({ requestId: 321, command, reason })
    const sealed = await vi.waitFor(async () => {
      const found = await card(321)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 3_500, interval: 50 })
    expect(sealed).toMatchObject({ ...hidden, execution: { state: "unresolved", reason: "sensitive-content" } })
    expect(JSON.stringify(sealed)).not.toMatch(leak)
  })

  // Round 12: a card sealed before its lookups finished hides its file in the
  // same forms, as written, and keeps the rest of the agent's text.
  it("shows [REDACTED] for a file named relative to the worktree on a card sealed when its lookups stall", async () => {
    const { directory, emit, card } = await setup(async (root) => {
      await mkdir(join(root, "src"))
      await writeFile(join(root, "src", ".env"), "")
    })
    vi.spyOn(fs.realpath, "native").mockImplementation((() => {}) as never)
    const reason = "Edit src/.env ./src/.env src\\.env .env; leave x.envy.txt, app.envrc.md and src/index.ts alone"
    emit({ requestId: 331, command: "Edit", reason, cwd: join(directory, "src"), path: ".env" })
    const sealed = await vi.waitFor(async () => {
      const found = await card(331)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 3_500, interval: 50 })
    expect(sealed).toMatchObject({
      risk: "hard-gate",
      command: "Edit",
      operation: "Edit [REDACTED] [REDACTED] [REDACTED] [REDACTED]; leave x.envy.txt, app.envrc.md and src/index.ts alone",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })

  // Round 12: a hidden file below the worktree root, requested from a nested
  // directory, stayed in the card's operation text when named relative to the
  // worktree. Each depth of file, from the root, its own directory, a sibling,
  // a parent and a linked directory, with the worktree as given and at its
  // real path, on a file card named absolute and relative and on a command
  // blocked on the file, in every copy of the card. The rest of the agent's
  // text stays.
  it("shows [REDACTED] for a hidden file however the card's text writes it, in every copy", async () => {
    const { directory, socket, emit, store, notices } = await setup(async (root) => {
      for (const path of ["src/app", "src/lib", "lib"]) await mkdir(join(root, ...path.split("/")), { recursive: true })
      await writeFile(join(root, "src", "index.ts"), "export {}\n")
      for (const file of ["src/.env", "src/app/.env"]) await writeFile(join(root, ...file.split("/")), "TOKEN=1")
      await symlink(join(root, "src"), join(root, "via"), "junction")
    }, undefined, { asGiven: true })
    const real = await realpath(directory)
    const slashed = (path: string) => path.split(sep).join("/")
    const controls = cardTextControls
    const cases = [
      { file: ".env", cwds: [".", "lib", ".."] },
      { file: "src/.env", cwds: [".", "src", "lib", "via"] },
      { file: "src/app/.env", cwds: [".", "src/app", "src/lib", "src", "via/app", "via"] },
    ]
    const expected = new Map<number, { label: string; operation: string; command: string }>()
    let id = 700
    for (const { file, cwds } of cases) {
      const given = join(directory, ...file.split("/"))
      const lies = join(real, ...file.split("/"))
      for (const cwd of cwds) {
        const cwdGiven = resolve(directory, cwd)
        const cwdLies = await realpath(cwdGiven)
        const relatives = [...new Set([file, slashed(relative(cwdGiven, given)), slashed(relative(cwdLies, lies))])]
        const written = [
          given,
          lies,
          ...relatives.flatMap((path) => {
            const backslashed = path.split("/").join("\\")
            return [path, `./${path}`, backslashed, `.\\${backslashed}`]
          }),
        ]
        const named = written.join(" ")
        const hidden = written.map(() => "[REDACTED]").join(" ")
        for (const [shape, path] of Object.entries({ absolute: given, relative: relative(cwdGiven, given) })) {
          emit({ requestId: ++id, command: "Edit", reason: `Edit ${named}; leave ${controls} alone`, cwd: cwdGiven, path })
          expected.set(id, { label: `file card for ${file} from ${cwd} (${shape})`, operation: `Edit ${hidden}; leave ${controls} alone`, command: "Edit" })
        }
        emit({ requestId: ++id, command: `cat ${named} src/index.ts`, reason: `Read ${named}; leave ${controls} alone`, cwd: cwdGiven, blockedPath: given })
        expected.set(id, { label: `blocked command on ${file} from ${cwd}`, operation: `Read ${hidden}; leave ${controls} alone`, command: `cat ${hidden} src/index.ts` })
      }
    }
    const current = async () => (await rpc(socket, "workspace.get")).result as WorkspaceSnapshot
    const lastChange = () => (JSON.parse(notices.at(-1)!) as { params: WorkspaceSnapshot }).params
    await waitForDaemon(async () => expect((await current()).approvals).toHaveLength(expected.size))
    await waitForDaemon(async () => expect(lastChange().approvals).toHaveLength(expected.size))

    // Every card whose text differs from what it should show, in one list.
    const missed = (copy: WorkspaceSnapshot, where: string) => copy.approvals.flatMap((card) => {
      const text = expected.get(card.providerRequestId!)!
      return card.operation === text.operation && card.command === text.command && card.risk === "hard-gate"
        ? []
        : [`${where}, ${text.label}: ${card.risk} | ${card.operation} | ${card.command}`
            .split(real).join("<real>").split(directory).join("<worktree>")]
    })
    expect([
      ...missed(await current(), "workspace.get"),
      ...missed(lastChange(), "workspace.changed"),
      ...missed(store.load(), "store.load"),
    ]).toEqual([])

    for (const card of (await current()).approvals) {
      expect((await rpc(socket, "approval.resolve", { approvalId: card.id, decision: "allow-once", revision: card.revision, client: "cli" })).error).toBeUndefined()
    }
    const operations = [...expected.values()].map((text) => text.operation)
    const receipts = (copy: WorkspaceSnapshot) => copy.thread.flatMap((item) => item.kind === "receipt" ? [item.operation] : [])
    expect(receipts(await current())).toEqual(expect.arrayContaining(operations))
    expect(receipts(store.load())).toEqual(expect.arrayContaining(operations))
  })

  // Round 13: a hidden file name that holds a comma stayed in the card's text
  // and in its receipt. Generated hidden file names, each a real file, written
  // every way an agent writes a path, show [REDACTED] in every copy of the
  // card and in the receipt, and the text around each path stays.
  it("shows [REDACTED] for generated hidden file names in every copy of the card and in its receipt", async () => {
    const run = hiddenNameRun(6)
    const paths = hiddenNamePaths(run).map((path, index) => `case-${index}/${path}`)
    const made = new Set<string>()
    const { directory, socket, emit, store, notices } = await setup(async (root) => {
      for (const path of paths) if (await createHiddenFile(root, path)) made.add(path)
    })
    type Expected = { label: string; path: string; forms: string[]; operation: string; command: string }
    const expected = new Map<number, Expected>()
    for (const [index, path] of paths.entries()) {
      if (!made.has(path)) continue
      const forms = [path, join(directory, ...path.split("/"))]
      const hidden = forms.map(() => "[REDACTED]")
      const id = 900 + index
      emit({ requestId: id, command: cardCommand(forms), reason: cardOperation(forms), path })
      expected.set(id, { label: `case ${index} ${JSON.stringify(path)}`, path, forms, operation: cardOperation(hidden), command: cardCommand(hidden) })
    }
    const current = async () => (await rpc(socket, "workspace.get")).result as WorkspaceSnapshot
    const lastChange = () => (JSON.parse(notices.at(-1)!) as { params: WorkspaceSnapshot }).params
    await waitForDaemon(async () => expect((await current()).approvals).toHaveLength(expected.size))
    await waitForDaemon(async () => expect(lastChange().approvals).toHaveLength(expected.size))

    const failures = (where: string, id: number, shown: { operation: string; command?: string }) => {
      const text = expected.get(id)!
      const check = (line: string, value: string, want: string) => cardTextFailures({
        label: `${where}, ${text.label} ${line}`, shown: value, expected: want, forms: text.forms, path: text.path,
      })
      return [
        ...check("operation", shown.operation, text.operation),
        ...(shown.command === undefined ? [] : check("command", shown.command, text.command)),
      ]
    }
    const cardFailures = (copy: WorkspaceSnapshot, where: string) => copy.approvals.flatMap((card) => [
      ...(card.risk === "hard-gate" ? [] : [`${where}, ${expected.get(card.providerRequestId!)!.label} is not a hard gate`]),
      ...failures(where, card.providerRequestId!, card),
    ])
    const found = [
      ...cardFailures(await current(), "workspace.get"),
      ...cardFailures(lastChange(), "workspace.changed"),
      ...cardFailures(store.load(), "store.load"),
    ]

    const ids = new Map<string, number>()
    for (const card of (await current()).approvals) {
      ids.set(card.id, card.providerRequestId!)
      expect((await rpc(socket, "approval.resolve", { approvalId: card.id, decision: "deny", client: "cli" })).error).toBeUndefined()
    }
    const receiptFailures = (copy: WorkspaceSnapshot, where: string) => copy.thread.flatMap((item) => {
      if (item.kind !== "receipt") return []
      const id = [...ids].find(([approvalId]) => item.id.startsWith(`receipt-${approvalId}-`))?.[1]
      return id === undefined ? [] : failures(where, id, { operation: item.operation })
    })
    const receipts = (copy: WorkspaceSnapshot) => copy.thread.filter((item) => item.kind === "receipt" && [...ids.keys()].some((id) => item.id.startsWith(`receipt-${id}-`)))
    expect(receipts(await current())).toHaveLength(expected.size)
    found.push(...receiptFailures(await current(), "receipt in workspace.get"), ...receiptFailures(store.load(), "receipt in store.load"))
    expect(found, `seed ${run.seed}, ${run.cases} cases, ${paths.length - made.size} names refused by the filesystem`).toEqual([])
  })

  // Round 14, owner ruling 2026-09-25: a second secret file that only the
  // agent's text names stayed in the card and its receipt. It is replaced in
  // every copy, and a card whose text names one is a hard gate that takes no
  // standing rule. An ordinary second path stays, and its card is not a hard
  // gate.
  it("shows [REDACTED] for a secret file only the card's text names, in every copy and the receipt", async () => {
    const { socket, emit, card, store, notices } = await setup(async (root) => {
      await mkdir(join(root, "src"))
      for (const file of [".env,prod", "private.pem", "index.ts", "app.ts"]) await writeFile(join(root, "src", file), "")
    })
    const leak = /private\.pem|\.env,prod/u
    const sent = notices.length
    emit({ requestId: 1001, command: "Edit", path: "src/.env,prod", reason: "Edit src/.env,prod with the key in src/private.pem; leave src/index.ts alone" })
    emit({ requestId: 1002, command: "Edit", path: "src/index.ts", reason: "Edit src/index.ts to load src/private.pem" })
    emit({ requestId: 1003, command: "Edit", path: "src/index.ts", reason: "Edit src/index.ts to match src/app.ts" })
    const shown = {
      1001: { risk: "hard-gate", operation: "Edit [REDACTED] with the key in [REDACTED]; leave src/index.ts alone" },
      1002: { risk: "hard-gate", operation: "Edit src/index.ts to load [REDACTED]" },
    }
    const cards = await waitForDaemon(async () => {
      const found = await Promise.all([1001, 1002, 1003].map(card))
      expect(found.every((approval) => approval !== undefined)).toBe(true)
      return found as Approval[]
    })
    const [first, second, ordinary] = cards as [Approval, Approval, Approval]
    expect(first).toMatchObject(shown[1001])
    expect(second).toMatchObject(shown[1002])
    expect(ordinary.risk).not.toBe("hard-gate")
    expect(ordinary.operation).toBe("Edit src/index.ts to match src/app.ts")
    expect(JSON.stringify([first, second])).not.toMatch(leak)

    await waitForDaemon(async () => {
      const last = (JSON.parse(notices.at(-1)!) as { params: WorkspaceSnapshot }).params
      expect(last.approvals).toHaveLength(3)
    })
    expect(notices.slice(sent).join("\n")).not.toMatch(leak)
    const saved = store.load().approvals
    expect(saved.find((approval) => approval.providerRequestId === 1001)).toMatchObject(shown[1001])
    expect(saved.find((approval) => approval.providerRequestId === 1002)).toMatchObject(shown[1002])

    const always = await rpc(socket, "approval.resolve", { approvalId: second.id, decision: "always-project", revision: second.revision, client: "cli" })
    expect(always.error?.message).toBe("Hard-gate approvals cannot create standing rules")
    for (const approval of [first, second]) {
      expect((await rpc(socket, "approval.resolve", { approvalId: approval.id, decision: "deny", client: "cli" })).error).toBeUndefined()
    }
    const receipt = (copy: WorkspaceSnapshot, approval: Approval) => copy.thread.find(
      (item) => item.kind === "receipt" && item.id.startsWith(`receipt-${approval.id}-`),
    )
    const current = (await rpc(socket, "workspace.get")).result as WorkspaceSnapshot
    for (const copy of [current, store.load()]) {
      expect(receipt(copy, first)).toMatchObject({ operation: shown[1001].operation })
      expect(receipt(copy, second)).toMatchObject({ operation: shown[1002].operation })
    }
    expect(JSON.stringify(store.load())).not.toMatch(leak)
    expect(notices.join("\n")).not.toMatch(leak)
    expect(JSON.stringify(store.auditLog.query({ limit: 100 }).entries)).not.toMatch(leak)
  })
})

// Round 15, finding 2: the reviewer's cards, through a live daemon.
describe("a text-only secret name beside non-ASCII punctuation or a line suffix", () => {
  it("is hidden whole in workspace.get, the store and the receipt", async () => {
    const { socket, emit, card, store } = await setup(async (root) => {
      await mkdir(join(root, "src"))
      await writeFile(join(root, "src", "index.ts"), "")
    })
    const cases = [
      { requestId: 1101, reason: "Compare src/index.ts with \u201csrc/key,prod.pem\u201d", operation: "Compare src/index.ts with \u201c[REDACTED]\u201d" },
      { requestId: 1102, reason: "Edit src/index.ts using src/prod,.env\u2014the key", operation: "Edit src/index.ts using [REDACTED]\u2014the key" },
      { requestId: 1103, reason: "Edit src/index.ts as src/deploy(1).pem:12 says", operation: "Edit src/index.ts as [REDACTED]:12 says" },
    ]
    const leak = /src\/key|src\/prod|deploy\(1\)/u
    for (const { requestId, reason } of cases) emit({ requestId, command: "Edit", path: "src/index.ts", reason })
    const cards = await waitForDaemon(async () => {
      const found = await Promise.all(cases.map(({ requestId }) => card(requestId)))
      expect(found.every((approval) => approval !== undefined)).toBe(true)
      return found as Approval[]
    })
    for (const [index, { operation }] of cases.entries()) {
      expect(cards[index]).toMatchObject({ risk: "hard-gate", operation })
      expect(store.load().approvals.find((approval) => approval.id === cards[index]!.id)).toMatchObject({ operation })
    }
    for (const approval of cards) {
      expect((await rpc(socket, "approval.resolve", { approvalId: approval.id, decision: "deny", client: "cli" })).error).toBeUndefined()
    }
    const current = (await rpc(socket, "workspace.get")).result as WorkspaceSnapshot
    for (const copy of [current, store.load()]) {
      for (const [index, { operation }] of cases.entries()) {
        expect(copy.thread.find((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${cards[index]!.id}-`)))
          .toMatchObject({ operation })
      }
    }
    expect(JSON.stringify(store.load())).not.toMatch(leak)
  })
})

// A saved card's execution record is not trusted at load: every path it can
// hold, moved by a link into a store after the card was saved, makes the card
// a hard gate with the record hidden.
describe("a saved card whose record path moved into a store", () => {
  type SchemaNode = {
    _zod: {
      def: {
        type: string
        shape?: Record<string, SchemaNode>
        options?: SchemaNode[]
        element?: SchemaNode
        innerType?: SchemaNode
        values?: unknown[]
      }
    }
  }

  // Every string field the record schema allows, named by where it sits: an
  // object key, and a union member by its kind. A construct this walk does not
  // know fails the test, so a new field cannot slip past it.
  function stringFields(node: SchemaNode, at: string): string[] {
    const def = node._zod.def
    const child = (key: string) => (at === "" ? key : `${at}.${key}`)
    switch (def.type) {
      case "string": return [at]
      case "literal":
      case "enum":
      case "number":
      case "boolean": return []
      case "nullable":
      case "optional": return stringFields(def.innerType!, at)
      case "array": return stringFields(def.element!, at)
      case "object": return Object.entries(def.shape!).flatMap(([key, value]) => stringFields(value, child(key)))
      case "union": return def.options!.flatMap((option) => {
        const kind = option._zod.def.shape?.["kind"]?._zod.def.values?.[0]
        if (typeof kind !== "string") throw new Error(`A union at ${at || "the record"} has a member without a kind`)
        return stringFields(option, at === "" ? kind : `${at}(${kind})`)
      })
      default: throw new Error(`The record schema holds a ${def.type} at ${at || "the record"} this table does not read`)
    }
  }

  // Each string field of the record: a path, or not a path and why.
  const recordStringFields: Record<string, "path" | { notAPath: string }> = {
    "shell.cwd": "path",
    "shell.entries.source(package-script).manifest": "path",
    "shell.entries.source(package-script).name": { notAPath: "a script name, which the schema limits to one segment" },
    "shell.entries.source(package-script).arguments": "path",
    "shell.entries.source(package-script).sourceDigest": { notAPath: "a sha256 digest" },
    "shell.entries.parts.argv": "path",
    "workspace-file-tool.cwd": "path",
    "workspace-file-tool.path": "path",
  }

  // The file a card names sits on the card, not in the record, and is judged
  // with them.
  const cardFileField = "card.affects"

  type Row = {
    id: number
    field: string
    // Runs in the row's own directory before the card is saved.
    prepare: (row: string) => Promise<void>
    request: (row: string) => { cwd: string; command: string; path?: string }
    // The path, relative to the row, that moves into the store.
    moves: string
  }

  const manifest = (show: string) => JSON.stringify({ scripts: { show } })
  const rows: Row[] = [
    {
      id: 101,
      field: "shell.cwd",
      prepare: (row) => mkdir(join(row, "sub")),
      request: (row) => ({ cwd: join(row, "sub"), command: "ls" }),
      moves: "sub",
    },
    {
      id: 102,
      field: "workspace-file-tool.cwd",
      prepare: async (row) => {
        await mkdir(join(row, "sub"))
        await writeFile(join(row, "sub", "notes.txt"), "")
      },
      request: (row) => ({ cwd: join(row, "sub"), command: "Edit", path: "notes.txt" }),
      moves: "sub",
    },
    {
      id: 103,
      field: "shell.entries.source(package-script).manifest",
      prepare: async (row) => {
        await writeFile(join(row, "package.json"), manifest("cat notes.txt"))
        await writeFile(join(row, "notes.txt"), "")
      },
      request: (row) => ({ cwd: row, command: "pnpm run show" }),
      moves: "package.json",
    },
    {
      id: 104,
      field: "shell.entries.source(package-script).arguments",
      prepare: async (row) => {
        await writeFile(join(row, "package.json"), manifest("cat"))
        await writeFile(join(row, "notes.txt"), "")
      },
      request: (row) => ({ cwd: row, command: "pnpm run show -- notes.txt" }),
      moves: "notes.txt",
    },
    {
      id: 105,
      field: "shell.entries.parts.argv",
      prepare: (row) => writeFile(join(row, "notes.txt"), ""),
      request: (row) => ({ cwd: row, command: "cat notes.txt" }),
      moves: "notes.txt",
    },
    {
      id: 106,
      field: "shell.entries.parts.argv",
      prepare: async (row) => {
        await writeFile(join(row, "package.json"), manifest("cat notes.txt"))
        await writeFile(join(row, "notes.txt"), "")
      },
      request: (row) => ({ cwd: row, command: "pnpm run show" }),
      moves: "notes.txt",
    },
    {
      id: 108,
      field: "workspace-file-tool.path",
      prepare: async (row) => {
        await mkdir(join(row, "sub"))
        await writeFile(join(row, "sub", "notes.txt"), "")
      },
      request: (row) => ({ cwd: row, command: "Edit", path: "sub/notes.txt" }),
      moves: "sub/notes.txt",
    },
    {
      id: 107,
      field: cardFileField,
      prepare: (row) => writeFile(join(row, "notes.txt"), ""),
      request: (row) => ({ cwd: row, command: "Edit", path: "notes.txt" }),
      moves: "notes.txt",
    },
  ]

  it("hard-gates and hides the record for every path field the record schema allows", async () => {
    // A kind can have several members (a file tool's workspace and file
    // scopes); a field is named once however many members hold it.
    const fields = [...new Set(stringFields(executionRecordSchema as unknown as SchemaNode, ""))]
    expect(fields.sort()).toEqual(Object.keys(recordStringFields).sort())
    for (const [field, kind] of Object.entries(recordStringFields)) {
      if (kind === "path") expect(rows.some((row) => row.field === field), `no row moves ${field}`).toBe(true)
    }
    expect(rows.some((row) => row.field === cardFileField)).toBe(true)

    const cards: Approval[] = []
    const root = await savedRoot(async (root) => {
      for (const row of rows) {
        const directory = join(root, `row-${row.id}`)
        await mkdir(directory)
        await row.prepare(directory)
        const request = row.request(directory)
        const { approval } = await settleApproval({
          approval: {
            id: `approval-moved-${row.id}`,
            revision: 0,
            sessionId: demoWorkspace.sessions[0]!.id,
            machine: "macbook-pro-m3",
            agent: "claude-code / sonnet",
            mode: "build",
            estimatedDuration: "Unknown",
            checkpoint: "unavailable",
            providerRequestId: row.id,
            requestedAt: "2026-09-24T00:00:00.000Z",
          },
          request: { workspace: root, reason: "Run a command", ...request },
          scope: undefined,
          execution: "resolve",
          risk: () => "normal",
        })
        const saved = structuredClone(approval) as Approval
        expect(saved, row.field).toMatchObject({ risk: "normal" })
        if (row.field !== cardFileField) expect(saved.execution, row.field).toMatchObject({ state: "resolved" })
        cards.push(saved)
        // Move the path into a store, and leave a link where it was.
        const from = join(directory, row.moves)
        const into = join(root, ".aws", `row-${row.id}`, row.moves)
        await mkdir(dirname(into), { recursive: true })
        await rename(from, into)
        await symlink(into, from)
      }
    })

    const settled = await settleSaved(cards, root)
    for (const row of rows) {
      const label = `${row.field} (row ${row.id})`
      const loaded = settled.get(row.id)
      expect.soft(loaded, label).toMatchObject({ risk: "hard-gate", execution: { state: "unresolved", reason: "sensitive-content" } })
      expect.soft(JSON.stringify(loaded), label).not.toContain(".aws")
    }
  })
})

// A file or read tool's saved card gives its file back only in a file line. A
// card saved in an older format, with a reach line or any other line in its
// place, cannot be resolved again as its request was: the file it named may
// lead into a store since, and nothing on the card says which file to judge.
// It is sealed when settled from its saved text, and stays sealed when settled again.
// A card whose file line reads back as a clean file is kept as it was.
describe("a saved file-scoped tool card without a file line", () => {
  // affects is the line the card is saved with in place of its file line;
  // the control row keeps its own.
  type Row = { id: number; tool: string; affects?: string; moves: boolean }
  const olderLines = [unrestrictedApprovalScope.command, "Reads files in the session worktree."]
  const cleanLine = (id: number) => `The file row-${id}/notes.txt in the session worktree.`
  const rows: Row[] = [
    ...fileScopedTools.flatMap((tool, index) => olderLines.map((affects, line) => ({
      id: 200 + index * olderLines.length + line,
      tool,
      affects,
      moves: true,
    }))),
    { id: 299, tool: "Read", moves: false },
  ]
  const sealed = rows.filter((row) => row.moves)
  const control = rows.find((row) => !row.moves)!

  it("seals each one after its file moved into a store, and keeps a clean Read card", async () => {
    expect(sealed.map((row) => row.tool)).toContain("Read")
    const cards: Approval[] = []
    const root = await savedRoot(async (root) => {
      for (const row of rows) {
        const directory = join(root, `row-${row.id}`)
        await mkdir(directory)
        await writeFile(join(directory, "notes.txt"), "")
        const { approval } = await settleApproval({
          approval: {
            id: `approval-tool-${row.id}`,
            revision: 0,
            sessionId: demoWorkspace.sessions[0]!.id,
            machine: "macbook-pro-m3",
            agent: "claude-code / sonnet",
            mode: "build",
            estimatedDuration: "Unknown",
            checkpoint: "unavailable",
            providerRequestId: row.id,
            requestedAt: "2026-09-24T00:00:00.000Z",
          },
          request: { workspace: root, cwd: directory, command: row.tool, path: "notes.txt", reason: "Use a tool" },
          scope: undefined,
          execution: "resolve",
          risk: () => "normal",
        })
        expect(approval, row.tool).toMatchObject({ risk: "normal", affects: cleanLine(row.id) })
        cards.push({ ...structuredClone(approval) as Approval, ...(row.affects === undefined ? {} : { affects: row.affects }) })
        if (!row.moves) continue
        const into = join(root, ".aws", `row-${row.id}`, "notes.txt")
        await mkdir(dirname(into), { recursive: true })
        await rename(join(directory, "notes.txt"), into)
        await symlink(into, join(directory, "notes.txt"))
      }
    })

    const settled = await settleSaved(cards, root)
    const sealedCard = {
      risk: "hard-gate",
      directory: "[REDACTED] in the session worktree",
      execution: { state: "unresolved", reason: "sensitive-content" },
    }
    for (const row of sealed) {
      const label = `${row.tool}: ${row.affects} (row ${row.id})`
      const loaded = settled.get(row.id)
      expect.soft(loaded, label).toMatchObject(sealedCard)
      expect.soft(JSON.stringify(loaded), label).not.toMatch(/\.aws|notes\.txt|row-/u)
      const again = await settleApproval(savedSettlementInput(loaded!, root, undefined, () => "normal"))
      expect.soft(again.approval, label).toMatchObject(sealedCard)
    }

    const kept = cards.find((approval) => approval.providerRequestId === control.id)!
    const { risk, directory, affects, execution } = kept
    expect(settled.get(control.id)).toMatchObject({ risk, directory, affects, execution })
  })
})
