import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  rpcMethods,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  activeProjectCap,
  DomovoiDaemon,
  type DaemonServerOptions,
  projectNotOpenRefusal,
  workspaceSnapshotForClient,
} from "./server.js"
import type { AgentAdapter } from "./agents.js"
import type { WorkspaceService } from "./workspace.js"
import { SqliteWorkspaceStore } from "./store.js"

// Named operations resolve active membership independently of shared focus.
// Unknown projects remain refused.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const directories: string[] = []
const rpcDeadlineMs = 10_000
const projectId = "project-acme"
const invalidParams = -32602
const digest = `sha256:${"a".repeat(64)}`

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(open: boolean, another = false, options: DaemonServerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-project-scope-"))
  directories.push(root)
  const empty = createEmptyWorkspace(demoWorkspace.machine)
  const project = { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: root, branch: "main" }
  const snapshot: WorkspaceSnapshot = open ? { ...empty, project } : empty
  if (another) {
    const otherPath = join(root, "other")
    await mkdir(otherPath)
    snapshot.projects = [project, { ...project, id: "project-b", name: "b", path: otherPath }]
    snapshot.project = snapshot.projects[1]!
  }
  const store = new SqliteWorkspaceStore(":memory:", snapshot)
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", store, errorSink: vi.fn(), ...options })
  daemons.push(daemon)
  await daemon.start()
  return { daemon, project, store }
}

async function connect(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(rpcDeadlineMs) })
  let id = 0
  const call = async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new Error(`${method} deadline expired`))), rpcDeadlineMs)
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        socket.off("message", receive)
        finish()
      }
      const receive = (data: WebSocket.RawData) => {
        const reply = JSON.parse(data.toString()) as Record<string, unknown>
        if (reply.id === requestId) settle(() => resolve(reply))
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
  const hello = await call("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })
  expect(hello).toHaveProperty("result")
  return { call, hello: hello.result as Record<string, unknown> }
}

function errorOf(reply: Record<string, unknown>) {
  return reply.error as { code: number, message: string } | undefined
}

const projectScoped: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["session.create", { title: "Fix the build", runtime: demoWorkspace.sessions[0]!.runtime, client: "desktop" }],
  ["tool.inventory", {}],
  ["skill.list", {}],
  ["skill.inventory", {}],
  ["skill.read", { id: "skill-0123456789ab" }],
  ["skill.reviewRevision", { id: "skill-0123456789ab", contentDigest: digest }],
  ["skill.setEnabled", { id: "skill-0123456789ab", enabled: true, contentDigest: digest, manifest: { version: 1, capabilities: [] } }],
  ["skill.review", { id: "skill-0123456789ab", contentDigest: digest, decision: "trust" }],
  ["skill.installPreview", { source: { kind: "path", path: "/Users/dev/skills/review" } }],
  ["skill.install", { source: { kind: "path", path: "/Users/dev/skills/review" }, scope: "project", sourceDigest: digest }],
]

describe("the active project list", () => {
  it("lists the open project and the cap in every snapshot it sends", async () => {
    const { daemon, project } = await fixture(true)
    const { call, hello } = await connect(daemon)
    expect(hello.projects).toEqual([project])
    expect(hello.projectCap).toBe(activeProjectCap)

    const workspace = workspaceSnapshotSchema.parse((await call("workspace.get", {})).result)
    expect(workspace.projects).toEqual([project])
    expect(workspace.projectCap).toBe(3)
  })

  it("lists no project before one is opened", async () => {
    const { daemon } = await fixture(false)
    const { call, hello } = await connect(daemon)
    expect(hello.projects).toEqual([])
    const workspace = workspaceSnapshotSchema.parse((await call("workspace.get", {})).result)
    expect(workspace.project).toBeNull()
    expect(workspace.projects).toEqual([])
    expect(workspace.projectCap).toBe(3)
  })

  // Every snapshot the daemon sends, results and workspace.changed alike, is
  // built by this one function.
  it("adds the list to the snapshot clients receive and not to the stored one", () => {
    const stored = structuredClone(demoWorkspace)
    delete stored.projects
    delete stored.projectCap
    const sent = workspaceSnapshotForClient(stored)
    expect(sent.projects).toEqual([demoWorkspace.project])
    expect(sent.projectCap).toBe(activeProjectCap)
    expect(stored).not.toHaveProperty("projects")
    expect(workspaceSnapshotForClient(createEmptyWorkspace(demoWorkspace.machine)).projects).toEqual([])
  })

  // Shared focus selects a project without hiding any other active project.
  it("states every active project while retaining shared focus", () => {
    const stored = structuredClone(demoWorkspace)
    stored.projects = [demoWorkspace.project!, { ...demoWorkspace.project!, id: "project-other", path: "/Users/dev/src/other" }]
    expect(workspaceSnapshotForClient(stored).projects).toEqual(stored.projects)
  })
})

describe("a call that names a project", () => {
  it.each(projectScoped)("%s is refused for a project that is not open", async (method, params) => {
    const { daemon } = await fixture(true)
    const { call } = await connect(daemon)
    const reply = await call(method, { ...params, projectId: "project-elsewhere" })
    expect(errorOf(reply)).toEqual({ code: invalidParams, message: projectNotOpenRefusal })
  })

  it("is refused when no project is open", async () => {
    const { daemon } = await fixture(false)
    const { call } = await connect(daemon)
    const reply = await call("tool.inventory", { projectId })
    expect(errorOf(reply)).toEqual({ code: invalidParams, message: projectNotOpenRefusal })
  })

  it("is answered for the open project as when it names none", async () => {
    const { daemon } = await fixture(true)
    const { call } = await connect(daemon)
    for (const method of ["tool.inventory", "skill.list", "skill.inventory"]) {
      const named = await call(method, { projectId })
      expect(named, method).toHaveProperty("result")
      expect(named.result, method).toEqual((await call(method, {})).result)
    }
    // A revision nobody retained answers unavailable, and the answer names
    // the revision only, not the project the call named.
    const revision = { id: "skill-0123456789ab", contentDigest: digest }
    const unavailable = { ...revision, state: "unavailable", reason: "not-retained" }
    expect((await call("skill.reviewRevision", revision)).result).toEqual(unavailable)
    const namedRevision = await call("skill.reviewRevision", { ...revision, projectId })
    expect(namedRevision.error).toBeUndefined()
    expect(namedRevision.result).toEqual(unavailable)
    const created = await call("session.create", { ...projectScoped[0]![1], projectId })
    expect(errorOf(created)?.message).not.toBe(projectNotOpenRefusal)
  })
})

describe("project.close", () => {
  it("closes an empty project without confirmation", async () => {
    const { daemon, project } = await fixture(true)
    const { call } = await connect(daemon)
    const reply = await call("project.close", { projectId: project.id, client: "desktop" })
    expect(errorOf(reply)).toBeUndefined()
    expect(reply.result).toMatchObject({ snapshot: { project: null, projects: [] }, sessions: [] })
  })
})

it("routes named non-focused project operations and grants only to A", async () => {
  const agent = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => [{
      provider: "codex", id: "gpt-5.6-sol", displayName: "Test model", description: "Test model",
      supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium", isDefault: true,
    }]),
    startThread: vi.fn(async () => "thread-a"), resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}), startTurn: vi.fn(async () => "turn-a"),
    steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(), onEvent: () => () => {}, close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const workspace = {
    inspect: vi.fn(async (path: string) => ({ root: path, name: "A", branch: "main", head: "a".repeat(40) })),
    createSessionWorkspace: vi.fn(async (path: string) => ({ path, branch: "session", baseCommit: "a".repeat(40) })),
    removeSessionWorkspace: vi.fn(async () => {}), checkpoint: vi.fn(), restore: vi.fn(),
  } satisfies WorkspaceService
  const { daemon, project, store } = await fixture(true, true, {
    agents: { codex: agent }, workspaceService: workspace,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
  })
  for (const [path, name] of [[project.path, "scope-a"], [join(project.path, "other"), "scope-b"]] as const) {
    const directory = join(path, ".agents", "skills", name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test instructions.\n---\nUse ${name}.\n`)
  }
  const { call } = await connect(daemon)
  const inventory = rpcMethods["tool.inventory"].result.parse((await call("tool.inventory", { projectId })).result)
  expect(inventory.repository).toMatchObject({ projectId, root: project.path })
  const otherInventory = rpcMethods["tool.inventory"].result.parse((await call("tool.inventory", {})).result)
  expect(otherInventory.repository).toMatchObject({ projectId: "project-b", root: join(project.path, "other") })
  const skills = rpcMethods["skill.list"].result.parse((await call("skill.list", { projectId })).result)
  expect(skills.some((skill) => skill.name === "scope-a")).toBe(true)
  expect(skills.some((skill) => skill.name === "scope-b")).toBe(false)
  const skill = skills.find((entry) => entry.name === "scope-a")!
  expect(await call("skill.setEnabled", { projectId, id: skill.id, enabled: true,
    contentDigest: skill.contentDigest, manifest: skill.manifest })).toHaveProperty("result")
  expect(store.load().skillEnablements).toEqual([expect.objectContaining({ projectId, skillId: skill.id, enabled: true })])
  expect(await call("repository.trust", { projectId, configDigest: inventory.repository!.configDigest, client: "desktop" })).toHaveProperty("result")
  expect(store.repositoryTrust.find(projectId)).toBeDefined()
  expect(store.repositoryTrust.find("project-b")).toBeUndefined()
  expect((await call("workspace.get", {})).result).toMatchObject({ project: { id: "project-b" } })
  const created = await call("session.create", { projectId, title: "A session", client: "desktop",
    runtime: { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", permissionMode: "build", auto: false } })
  expect(created).not.toHaveProperty("error")
  expect(workspace.inspect).toHaveBeenCalledWith(project.path, expect.any(AbortSignal))
  expect(workspace.createSessionWorkspace).toHaveBeenCalledWith(project.path, expect.any(String), expect.anything())
  expect(store.load().sessions).toEqual([expect.objectContaining({ projectId, workspacePath: project.path })])
  expect(store.load().projects).toHaveLength(2)
})
