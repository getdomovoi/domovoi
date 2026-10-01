import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  repositoryGitFilterErrorCode,
  repositoryGitFilterRefusalSchema,
  type Runtime,
  type ToolInventory,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { projectRootRead } from "./repository-trust-apply.js"
import type { RepositoryTrustGrant, RepositoryTrustStore } from "./repository-trust-store.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

// P8 PR B end to end: the daemon's own workspace service looks this machine's
// grant up for the open project at every filter-running operation, so a
// trusted repository's reviewed filters run, and a revoked one is refused
// with the git filter code and its data.

const execute = promisify(execFile)
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratchDirectories: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories)
})

const projectId = "project-filtered"
const claude: Runtime = { provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false }

function agent() {
  const listeners = new Set<(event: AgentEvent) => void>()
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => [{
      provider: claude.provider, id: claude.model, displayName: claude.model, description: "",
      supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high", isDefault: true,
    }]),
    startThread: vi.fn(async (_input: Parameters<AgentAdapter["startThread"]>[0]) => "claude-thread"),
    resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "turn-1"),
    steerTurn: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
}

async function fixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "domovoi-server-filter-trust-")))
  scratchDirectories.push(scratch)
  const repositoryPath = join(scratch, "project")
  // Git runs a filter command through sh, which reads an unquoted backslash
  // as an escape: a Windows path keeps its separators only as forward slashes.
  const marker = join(scratch, "ran").replaceAll("\\", "/")
  const script = async (name: string, body: string) => {
    const path = join(scratch, `${name}.sh`).replaceAll("\\", "/")
    await writeFile(path, `echo ${name} >> "${marker}"\n${body}\n`)
    return path
  }
  const git = (...args: string[]) => execute("git", ["-C", repositoryPath, ...args])
  await execute("git", ["init", "--initial-branch=main", repositoryPath])
  await git("config", "core.autocrlf", "false")
  await writeFile(join(repositoryPath, ".gitattributes"), "victim.txt filter=agent\n")
  await writeFile(join(repositoryPath, "victim.txt"), "base\n")
  await git("add", ".")
  await git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", "initial")
  await git("config", "filter.agent.clean", `sh ${await script("clean", "tr A-Z a-z")}`)
  await git("config", "filter.agent.smudge", `sh ${await script("smudge", "tr a-z A-Z")}`)
  const markers = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean)

  const snapshot: WorkspaceSnapshot = {
    ...createEmptyWorkspace(demoWorkspace.machine),
    project: { id: projectId, machineId: demoWorkspace.machine.id, name: "project", path: repositoryPath, branch: "main" },
  }
  const trust = { current: undefined as RepositoryTrustGrant | undefined }
  const repositoryTrust: RepositoryTrustStore = {
    find: () => trust.current,
    record: vi.fn((input) => {
      const grant: RepositoryTrustGrant = { ...input, trustedAt: "2026-09-30T12:00:00.000Z" }
      trust.current = grant
      return grant
    }),
    revoke: vi.fn(() => { trust.current = undefined }),
  }
  const daemon = new DomovoiDaemon({
    port: 0,
    statePath: ":memory:",
    profileDirectory: join(scratch, "profile"),
    worktreeRoot: join(scratch, "worktrees"),
    store: new SqliteWorkspaceStore(":memory:", snapshot),
    agents: { "claude-code": agent() },
    repositoryTrust,
    errorSink: vi.fn(),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    const id = ++nextId
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { id?: number }
      if (message.id !== id) return
      socket.off("message", receive)
      resolve(message as Record<string, unknown>)
    }
    socket.on("message", receive)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect(await rpc("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).toHaveProperty("result")
  // `reviewed` false is a client that never showed the git filters.
  const trustNow = async (reviewed = true) => {
    const { configDigest } = await readRepositoryProviderConfig(repositoryPath, projectRootRead)
    expect(await rpc("repository.trust", { projectId, configDigest, client: "desktop", ...(reviewed ? { gitFilters: { reviewed: true } } : {}) }))
      .toMatchObject({ result: { outcome: "trusted" } })
  }
  const inventory = async () => ((await rpc("tool.inventory", {})).result as ToolInventory).repository?.gitFilters?.entries.map(({ heldBack }) => heldBack)
  return { rpc, markers, trustNow, inventory, repositoryPath }
}

describe("a trusted repository's git filters through the daemon", () => {
  it("runs them at create and checkpoint under a grant, and refuses with the git filter code after revoke", async () => {
    const { rpc, markers, trustNow, inventory } = await fixture()
    expect(await inventory()).toEqual([true, true])
    await trustNow()
    expect(await inventory()).toEqual([false, false])

    const created = await rpc("session.create", { client: "desktop", title: "trusted", runtime: claude })
    expect(created).toHaveProperty("result")
    const session = (created.result as WorkspaceSnapshot).sessions.at(-1)!
    expect(await readFile(join(session.workspacePath!, "victim.txt"), "utf8")).toBe("BASE\n")
    expect(await markers()).toEqual(["smudge"])

    await writeFile(join(session.workspacePath!, "victim.txt"), "CHANGED\n")
    expect(await rpc("checkpoint.create", { sessionId: session.id, label: "trusted", client: "desktop" })).toHaveProperty("result")
    expect(await markers()).toContain("clean")

    // Revoke stops no thread for a filter: a filter loads into no agent
    // thread, and runs only within a Git command (P8 plan section 4).
    expect(await rpc("repository.revokeTrust", { projectId, client: "desktop" })).toMatchObject({ result: { threads: [] } })
    expect(await inventory()).toEqual([true, true])
    await writeFile(join(session.workspacePath!, "victim.txt"), "AGAIN\n")
    const before = await markers()

    const refused = await rpc("checkpoint.create", { sessionId: session.id, label: "revoked", client: "desktop" }) as { error: { code: number; data?: unknown } }

    expect(refused.error.code).toBe(repositoryGitFilterErrorCode)
    expect(repositoryGitFilterRefusalSchema.parse(refused.error.data)).toMatchObject({
      projectId,
      trust: { state: "untrusted", reason: "not-trusted" },
      drivers: [{ name: "agent", scope: "local" }],
    })
    expect(await markers()).toEqual(before)
    expect(await readFile(join(session.workspacePath!, "victim.txt"), "utf8")).toBe("AGAIN\n")
  }, 30_000)

  // A client that does not say it showed the git filters, an older one,
  // grants trust for everything else, and the filters stay held back.
  it("keeps the filters held back under a grant whose client did not show them", async () => {
    const { rpc, markers, trustNow, inventory } = await fixture()
    await trustNow(false)
    expect(await inventory()).toEqual([true, true])

    const refused = await rpc("session.create", { client: "desktop", title: "unreviewed", runtime: claude }) as { error: { code: number; message: string; data?: unknown } }

    expect(refused.error.code).toBe(repositoryGitFilterErrorCode)
    expect(refused.error.message).toContain("trust it again from an updated Domovoi client")
    expect(repositoryGitFilterRefusalSchema.parse(refused.error.data)).toMatchObject({ projectId, drivers: [{ name: "agent", scope: "local" }] })
    expect(await markers()).toEqual([])
  }, 30_000)
})
