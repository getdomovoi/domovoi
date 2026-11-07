import { createHash } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  createEmptyWorkspace,
  demoWorkspace,
  maximumKnownProjects,
  maximumKnownProjectSessions,
  projectListResultSchema,
  protocolVersion,
  type Machine,
  type Project,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { knownProjectEntries, maximumProjectListBytes } from "./known-projects.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import type { WorkspaceService } from "./workspace.js"

// Rulings Q158 A and Q159 A: opening another project keeps the one before it
// listed. The daemon keeps one project active (ruling Q257), so the snapshot
// holds the focused project's sessions only; project.list reads every saved
// project and its sessions back.

const scratchDirectories: string[] = []
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories)
})

const machine: Machine = demoWorkspace.machine

function projectIdFor(root: string): string {
  return `project-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`
}

function projectAt(root: string): Project {
  return { id: projectIdFor(root), machineId: machine.id, name: root.split("/").at(-1)!, path: root, branch: "main" }
}

function sessionIn(project: Project, index: number, updatedAt = "2026-11-01T10:00:00.000Z"): WorkspaceSnapshot["sessions"][number] {
  const session = structuredClone(demoWorkspace.sessions[0]!)
  delete session.forkedFrom
  delete session.transfer
  delete session.activeTurnId
  return {
    ...session,
    id: `session-${project.name}-${index}`,
    projectId: project.id,
    title: `${project.name} work ${index}`,
    state: "idle",
    updatedAt,
    workspacePath: `/worktrees/${project.name}-${index}`,
  }
}

function projectRow(project: Project, sessions: WorkspaceSnapshot["sessions"]): string {
  return JSON.stringify({
    project,
    sessions,
    activeSessionId: null,
    approvals: [],
    approvalRules: [],
    thread: [],
    artifacts: [],
    workingPlans: [],
    annotations: [],
  })
}

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-project-list-"))
  scratchDirectories.push(directory)
  return directory
}

// A daemon on a stored database, seeded with `seed` when the database is new,
// with a repository inspection that takes any path as the repository root.
async function openDaemon(databasePath: string, seed: WorkspaceSnapshot = createEmptyWorkspace(machine)) {
  const workspaceService = {
    inspect: async (path: string) => ({ root: path, name: path.split("/").at(-1), branch: "main", head: "a".repeat(40) }),
  } as unknown as WorkspaceService
  const errorSink = vi.fn()
  const daemon = new DomovoiDaemon({
    port: 0,
    store: new SqliteWorkspaceStore(databasePath, seed),
    workspaceService,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    errorSink,
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
  const openProject = async (path: string) => {
    const opened = await rpc("project.open", { path, client: "desktop" })
    const confirmation = (opened.error as { data?: { kind?: string } } | undefined)?.data
    if (confirmation?.kind !== "project-switch-confirmation") return opened
    return rpc("project.open", { path, client: "desktop", confirmation })
  }
  const listProjects = async () => {
    const reply = await rpc("project.list", {})
    expect(reply).not.toHaveProperty("error")
    return projectListResultSchema.parse(reply.result)
  }
  return { daemon, rpc, openProject, listProjects, errorSink }
}

function insertProjectRow(databasePath: string, projectId: string, state: string, updatedAt: string): void {
  const database = new DatabaseSync(databasePath)
  database.prepare("INSERT INTO workspace_projects (project_id, state, updated_at) VALUES (?, ?, ?)")
    .run(projectId, state, updatedAt)
  database.close()
}

// Several live projects (J31 S2) are not something this daemon can load yet
// (ruling Q257), so the state is constructed: each live project lists only
// the sessions whose projectId names it, the focused one first, and a saved
// row never stands in for a live project.
describe("the project list's live entries", () => {
  it("gives each live project only its own sessions, and saved rows only the rest", () => {
    const a = projectAt("/code/acme-api")
    const b = projectAt("/code/pdf-worker")
    const c = projectAt("/code/docs")
    const snapshot: WorkspaceSnapshot = {
      ...createEmptyWorkspace(machine),
      project: b,
      projects: [a, b],
      sessions: [sessionIn(a, 1), sessionIn(b, 1), sessionIn(a, 2, "2026-11-03T10:00:00.000Z")],
    }
    const stale = { project: a, savedAt: "2026-10-01T00:00:00.000Z", sessions: [] }
    const saved = { project: c, savedAt: "2026-10-02T00:00:00.000Z", sessions: [{ id: "session-docs-1", title: "Docs", state: "idle" as const, updatedAt: "2026-10-02T00:00:00.000Z" }] }
    const { projects, omittedProjects } = knownProjectEntries(snapshot, { projects: [saved, stale], unreadable: [] }, "2026-11-06T00:00:00.000Z")
    expect(projects.map((known) => [known.project.id, known.sessions.map((session) => session.id)])).toEqual([
      [b.id, ["session-pdf-worker-1"]],
      [a.id, ["session-acme-api-2", "session-acme-api-1"]],
      [c.id, ["session-docs-1"]],
    ])
    expect(projects[1]!.savedAt).toBe("2026-10-01T00:00:00.000Z")
    expect(projects[0]!.savedAt).toBe("2026-11-06T00:00:00.000Z")
    expect(omittedProjects).toBe(0)
  })
})

// The daemon closes a socket whose unsent frames pass 1 MiB, so the list is
// cut to a byte budget as well as to its counts, and says what it left out.
describe("the project list's size", () => {
  it("stays within its byte budget with long titles in every project, counting what it left out", () => {
    const projects = Array.from({ length: 12 }, (_, index) => {
      const project = projectAt(`/code/project-${index}`)
      return {
        project,
        savedAt: "2026-11-01T00:00:00.000Z",
        sessions: Array.from({ length: maximumKnownProjectSessions }, (_, session) => ({
          id: `session-${index}-${session}`,
          title: "t".repeat(400),
          state: "idle" as const,
          updatedAt: "2026-11-01T00:00:00.000Z",
        })),
      }
    })
    const { projects: listed, omittedProjects } = knownProjectEntries(createEmptyWorkspace(machine), { projects, unreadable: [] })
    const result = projectListResultSchema.parse({
      projects: listed.map((known) => ({ ...known, folder: "unreadable" })),
      ...(omittedProjects > 0 ? { omittedProjects } : {}),
    })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(maximumProjectListBytes)
    const kept = listed.reduce((count, known) => count + known.sessions.length, 0)
    const left = listed.reduce((count, known) => count + (known.omittedSessions ?? 0), 0)
    expect(kept).toBeGreaterThan(0)
    expect(kept + left + omittedProjects * maximumKnownProjectSessions).toBe(12 * maximumKnownProjectSessions)
    // The newest project keeps the most: the budget is spent in list order.
    expect(listed[0]!.sessions.length).toBe(maximumKnownProjectSessions)
  })
})

describe("project.list", () => {
  it("keeps the project that was open listed with its sessions after another project opens", async () => {
    const scratch = await scratchDirectory()
    const rootA = join(scratch, "acme-api")
    const rootB = join(scratch, "pdf-worker")
    await mkdir(rootA)
    await mkdir(rootB)
    const projectA = projectAt(rootA)
    const seed = { ...createEmptyWorkspace(machine), project: projectA, sessions: [sessionIn(projectA, 1), sessionIn(projectA, 2, "2026-11-02T10:00:00.000Z")] }
    const { openProject, rpc, listProjects } = await openDaemon(join(scratch, "state.sqlite"), seed)

    const opened = await openProject(rootB)
    expect(opened).not.toHaveProperty("error")
    // What the owner saw: the snapshot now holds project B and none of A's
    // sessions, because the daemon keeps one project active.
    const snapshot = (await rpc("workspace.get", {})).result as WorkspaceSnapshot
    expect(snapshot.project?.path).toBe(rootB)
    expect(snapshot.sessions).toEqual([])

    const listed = await listProjects()
    expect(listed.projects.map((known) => known.project.path)).toEqual([rootB, rootA])
    const a = listed.projects[1]!
    expect(a.folder).toBe("present")
    // Newest first, and only what a row draws: no worktree path.
    expect(a.sessions).toEqual([
      { id: "session-acme-api-2", title: "acme-api work 2", state: "idle", updatedAt: "2026-11-02T10:00:00.000Z" },
      { id: "session-acme-api-1", title: "acme-api work 1", state: "idle", updatedAt: "2026-11-01T10:00:00.000Z" },
    ])
    expect(JSON.stringify(listed)).not.toContain("/worktrees/")

    // Opening A again brings its sessions back into the snapshot.
    expect(await openProject(rootA)).not.toHaveProperty("error")
    const back = (await rpc("workspace.get", {})).result as WorkspaceSnapshot
    expect(back.sessions.map((session) => session.id).sort()).toEqual(["session-acme-api-1", "session-acme-api-2"])
  })

  it("lists the open project first from the live snapshot, before it is saved", async () => {
    const scratch = await scratchDirectory()
    const root = join(scratch, "acme-api")
    await mkdir(root)
    const project = projectAt(root)
    const seed = { ...createEmptyWorkspace(machine), project, sessions: [sessionIn(project, 1)] }
    const { listProjects } = await openDaemon(join(scratch, "state.sqlite"), seed)
    const listed = await listProjects()
    expect(listed.projects[0]).toMatchObject({ project, folder: "present", sessions: [{ id: "session-acme-api-1" }] })
  })

  it("lists a project whose folder is gone as missing rather than dropping it or failing the list", async () => {
    const scratch = await scratchDirectory()
    const databasePath = join(scratch, "state.sqlite")
    await openDaemon(databasePath).then(({ daemon }) => daemon.stop())
    const gone = projectAt(join(scratch, "removed-repo"))
    const notADirectory = projectAt("/dev/null/inside")
    insertProjectRow(databasePath, gone.id, projectRow(gone, [sessionIn(gone, 1)]), "2026-11-05T00:00:00.000Z")
    insertProjectRow(databasePath, notADirectory.id, projectRow(notADirectory, []), "2026-11-04T00:00:00.000Z")
    const { listProjects } = await openDaemon(databasePath)
    const listed = await listProjects()
    expect(listed.projects.map((known) => [known.project.id, known.folder])).toEqual([
      [gone.id, "missing"],
      [notADirectory.id, "missing"],
    ])
    expect(listed.projects[0]!.sessions.map((session) => session.id)).toEqual(["session-removed-repo-1"])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says a folder it could not read is unreadable", async () => {
    const scratch = await scratchDirectory()
    const databasePath = join(scratch, "state.sqlite")
    await openDaemon(databasePath).then(({ daemon }) => daemon.stop())
    const locked = join(scratch, "locked")
    await mkdir(join(locked, "repo"), { recursive: true })
    const hidden = projectAt(join(locked, "repo"))
    insertProjectRow(databasePath, hidden.id, projectRow(hidden, []), "2026-11-05T00:00:00.000Z")
    await chmod(locked, 0o000)
    try {
      const { listProjects } = await openDaemon(databasePath)
      expect((await listProjects()).projects.map((known) => known.folder)).toEqual(["unreadable"])
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it("leaves out a saved row it cannot read, reports it, and lists the rest", async () => {
    const scratch = await scratchDirectory()
    const databasePath = join(scratch, "state.sqlite")
    await openDaemon(databasePath).then(({ daemon }) => daemon.stop())
    const kept = projectAt(join(scratch, "kept"))
    insertProjectRow(databasePath, kept.id, projectRow(kept, []), "2026-11-05T00:00:00.000Z")
    insertProjectRow(databasePath, "project-damaged", "{not json", "2026-11-06T00:00:00.000Z")
    const other = projectAt(join(scratch, "other"))
    insertProjectRow(databasePath, "project-mislabelled", projectRow(other, []), "2026-11-06T00:00:00.000Z")
    // Valid JSON whose project or sessions is a string, not an object or an
    // array: SQLite hands a string back unquoted.
    insertProjectRow(databasePath, "project-string", JSON.stringify({ project: "broken", sessions: [] }), "2026-11-06T00:00:00.000Z")
    insertProjectRow(databasePath, "project-string-sessions", JSON.stringify({ project: projectAt(join(scratch, "string-sessions")), sessions: "broken" }), "2026-11-06T00:00:00.000Z")
    const { listProjects, errorSink } = await openDaemon(databasePath)
    expect((await listProjects()).projects.map((known) => known.project.id)).toEqual([kept.id])
    const reported = errorSink.mock.calls.map(([report]) => (report as { context: string }).context)
    expect(reported).toEqual(expect.arrayContaining([
      "Domovoi could not read the saved project project-damaged for the project list",
      "Domovoi could not read the saved project project-mislabelled for the project list",
      "Domovoi could not read the saved project project-string for the project list",
      "Domovoi could not read the saved project project-string-sessions for the project list",
    ]))
  })

  it("is bounded, newest first, and counts what it left out", async () => {
    const scratch = await scratchDirectory()
    const databasePath = join(scratch, "state.sqlite")
    await openDaemon(databasePath).then(({ daemon }) => daemon.stop())
    const busy = projectAt(join(scratch, "busy"))
    const sessions = Array.from({ length: maximumKnownProjectSessions + 3 }, (_, index) => (
      sessionIn(busy, index, new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString())
    ))
    insertProjectRow(databasePath, busy.id, projectRow(busy, sessions), "2026-11-06T00:00:00.000Z")
    for (let index = 0; index < maximumKnownProjects + 1; index += 1) {
      const project = projectAt(join(scratch, `old-${index}`))
      insertProjectRow(databasePath, project.id, projectRow(project, []), new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString())
    }
    const { listProjects } = await openDaemon(databasePath)
    const listed = await listProjects()
    expect(listed.projects).toHaveLength(maximumKnownProjects)
    expect(listed.omittedProjects).toBe(2)
    expect(listed.projects[0]!.project.id).toBe(busy.id)
    expect(listed.projects[1]!.project.name).toBe(`old-${maximumKnownProjects}`)
    expect(listed.projects[0]!.sessions).toHaveLength(maximumKnownProjectSessions)
    expect(listed.projects[0]!.omittedSessions).toBe(3)
    expect(listed.projects[0]!.sessions[0]!.id).toBe(`session-busy-${maximumKnownProjectSessions + 2}`)
  })
})
