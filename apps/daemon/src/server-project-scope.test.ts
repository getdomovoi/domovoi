import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  activeProjectCap,
  DomovoiDaemon,
  projectCloseUnavailableRefusal,
  projectNotOpenRefusal,
  workspaceSnapshotForClient,
} from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

// J31 S1: the daemon states its active projects and cap in every snapshot,
// while it still keeps one project open at a time. A call that names any
// other project is refused, and project.close is refused until S3.

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

async function fixture(open: boolean) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-project-scope-"))
  directories.push(root)
  const empty = createEmptyWorkspace(demoWorkspace.machine)
  const project = { id: projectId, machineId: demoWorkspace.machine.id, name: "acme", path: root, branch: "main" }
  const snapshot: WorkspaceSnapshot = open ? { ...empty, project } : empty
  const store = new SqliteWorkspaceStore(":memory:", snapshot)
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", store, errorSink: vi.fn() })
  daemons.push(daemon)
  await daemon.start()
  return { daemon, project }
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
    expect(workspace.projectCap).toBe(1)
  })

  it("lists no project before one is opened", async () => {
    const { daemon } = await fixture(false)
    const { call, hello } = await connect(daemon)
    expect(hello.projects).toEqual([])
    const workspace = workspaceSnapshotSchema.parse((await call("workspace.get", {})).result)
    expect(workspace.project).toBeNull()
    expect(workspace.projects).toEqual([])
    expect(workspace.projectCap).toBe(1)
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

  // The open project is the one the daemon acts on, so the list it states is
  // that project alone, whatever list a stored snapshot carried.
  it("states the open project alone while one project is open at a time", () => {
    const stored = structuredClone(demoWorkspace)
    stored.projects = [demoWorkspace.project!, { ...demoWorkspace.project!, id: "project-other", path: "/Users/dev/src/other" }]
    expect(workspaceSnapshotForClient(stored).projects).toEqual([demoWorkspace.project])
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
    const created = await call("session.create", { ...projectScoped[0]![1], projectId })
    expect(errorOf(created)?.message).not.toBe(projectNotOpenRefusal)
  })
})

describe("project.close", () => {
  it("is refused until closing a project is built, and changes nothing", async () => {
    const { daemon, project } = await fixture(true)
    const { call } = await connect(daemon)
    const before = (await call("workspace.get", {})).result
    const reply = await call("project.close", { projectId: project.id, client: "desktop" })
    expect(errorOf(reply)).toEqual({ code: invalidParams, message: projectCloseUnavailableRefusal })
    expect((await call("workspace.get", {})).result).toEqual(before)
  })
})
