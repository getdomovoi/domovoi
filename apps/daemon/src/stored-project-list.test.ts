import { once } from "node:events"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  createEmptyWorkspace,
  demoWorkspace,
  protocolVersion,
  type Machine,
  type Project,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DomovoiDaemon, workspaceSnapshotForClient } from "./server.js"
import { MultiProjectWorkspaceStateError, SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import type { WorkspaceService } from "./workspace.js"

// Ruling Q257: this daemon keeps one project open at a time. State a newer
// Domovoi wrote with several active projects is refused at load and left as
// it is, so that version finds its sessions again. A list naming only the
// open project is dropped at load, so no stale list reaches a later save.

const scratchDirectories: string[] = []
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories)
})

const machine: Machine = demoWorkspace.machine
const projectA: Project = { id: "project-a", machineId: machine.id, name: "a", path: "/code/a", branch: "main" }
const projectB: Project = { id: "project-b", machineId: machine.id, name: "b", path: "/code/b", branch: "main" }

function sessionIn(projectId: string): WorkspaceSnapshot["sessions"][number] {
  const session = structuredClone(demoWorkspace.sessions[0]!)
  delete session.forkedFrom
  delete session.transfer
  return { ...session, id: `session-${projectId}`, projectId }
}

function ruleIn(projectId: string): WorkspaceSnapshot["approvalRules"][number] {
  return {
    id: `rule-${projectId}`,
    projectId,
    operation: "Run tests",
    command: "pnpm test",
    createdBy: "desktop",
    createdAt: "2026-08-25T21:40:00.000Z",
    useCount: 0,
    status: "inactive",
    inactiveReason: "legacy-text-only",
    inactivatedAt: "2026-08-25T21:41:00.000Z",
  }
}

const base = (): WorkspaceSnapshot => ({ ...createEmptyWorkspace(machine), project: projectA })

// What a newer daemon could have stored, as JSON, since some of these do not
// parse as a snapshot at all.
const severalProjects: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["another active project with its session", { ...base(), projects: [projectA, projectB], projectCap: 3, sessions: [sessionIn(projectB.id)] }],
  ["another active project alone", { ...base(), projects: [projectA, projectB], projectCap: 3 }],
  ["a session of a project the list leaves out", { ...base(), projects: [projectA], projectCap: 3, sessions: [sessionIn(projectB.id)] }],
  ["an approval rule of a project the list leaves out", { ...base(), projects: [projectA], projectCap: 3, approvalRules: [ruleIn(projectB.id)] }],
  // Ruling Q258: without a list too. Such state does not parse as a snapshot,
  // and must not be moved aside and replaced with the seed.
  ["a session of another project, with no list", { ...base(), sessions: [sessionIn(projectB.id)] }],
  ["an approval rule of another project, with no list", { ...base(), approvalRules: [ruleIn(projectB.id)] }],
]

async function storedState(snapshot: Record<string, unknown>) {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-stored-projects-"))
  scratchDirectories.push(scratch)
  const databasePath = join(scratch, "state.sqlite")
  const seeded = new SqliteWorkspaceStore(databasePath, createEmptyWorkspace(machine))
  await seeded.close()
  const written = JSON.stringify(snapshot)
  const database = new DatabaseSync(databasePath)
  database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(written)
  database.close()
  return { scratch, databasePath, written }
}

function storedRow(databasePath: string): string {
  const database = new DatabaseSync(databasePath)
  try {
    return (database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get() as { snapshot: string }).snapshot
  } finally {
    database.close()
  }
}

describe("stored state with several active projects", () => {
  it.each(severalProjects)("is refused at load, with nothing on disk changed: %s", async (_label, snapshot) => {
    const { scratch, databasePath, written } = await storedState(snapshot)
    const bytes = await readFile(databasePath)
    let refusal: unknown
    try {
      new SqliteWorkspaceStore(databasePath, createEmptyWorkspace(machine))
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(MultiProjectWorkspaceStateError)
    expect((refusal as Error).message).toBe(
      `Domovoi state at ${databasePath} was written by a newer Domovoi that keeps several projects open, and this daemon keeps one project open at a time. It was left as it is and this daemon did not start. Run the newer Domovoi again.`,
    )
    expect(() => new DomovoiDaemon({ port: 0, statePath: databasePath })).toThrow(MultiProjectWorkspaceStateError)
    expect(storedRow(databasePath)).toBe(written)
    expect((await readdir(scratch)).filter((name) => name.includes("corrupt"))).toEqual([])
    expect((await readFile(databasePath)).equals(bytes)).toBe(true)
  })

  it("is refused when a store holding it is handed to the daemon", () => {
    const snapshot = { ...base(), projects: [projectA, projectB], projectCap: 3, sessions: [sessionIn(projectB.id)] }
    const store = new SqliteWorkspaceStore(":memory:", snapshot)
    expect(() => new DomovoiDaemon({ port: 0, statePath: ":memory:", store, errorSink: vi.fn() }))
      .toThrow(MultiProjectWorkspaceStateError)
  })
})

describe("a stored list naming only the open project", () => {
  it("is dropped at load, so opening another project saves no stale list", async () => {
    const { databasePath } = await storedState({ ...base(), projects: [projectA], projectCap: 1, sessions: [sessionIn(projectA.id)] })
    const store = new SqliteWorkspaceStore(databasePath, createEmptyWorkspace(machine))
    const loaded = store.load()
    expect(loaded.project).toEqual(projectA)
    expect(loaded).not.toHaveProperty("projects")
    expect(loaded).not.toHaveProperty("projectCap")

    const workspaceService = {
      inspect: async (path: string) => ({ root: path, name: path.split("/").at(-1), branch: "main", head: "a".repeat(40) }),
    } as unknown as WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(databasePath, createEmptyWorkspace(machine)),
      workspaceService,
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
      errorSink: vi.fn(),
    })
    daemons.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    sockets.push(socket)
    await once(socket, "open")
    let id = 0
    const rpc = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
      const requestId = ++id
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
    expect(await rpc("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken }))
      .not.toHaveProperty("error")
    let opened = await rpc("project.open", { path: "/code/c", client: "desktop" })
    const confirmation = (opened.error as { data?: unknown } | undefined)?.data
    if (confirmation) opened = await rpc("project.open", { path: "/code/c", client: "desktop", confirmation })
    expect(opened).not.toHaveProperty("error")
    const result = opened.result as WorkspaceSnapshot
    expect(result.project?.path).toBe("/code/c")
    expect(result.projects).toEqual([result.project])
    await daemon.stop()
    daemons.splice(0)
    expect(JSON.parse(storedRow(databasePath))).not.toHaveProperty("projects")
  })
})

describe("the snapshot a client receives", () => {
  it("is never sent with a session outside the projects it lists", () => {
    const snapshot = { ...base(), sessions: [sessionIn(projectB.id)] }
    expect(() => workspaceSnapshotForClient(snapshot)).toThrow(/outside the projects it lists/)
  })
})
