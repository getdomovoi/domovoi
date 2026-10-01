import { describe, expect, it } from "vitest"

import {
  createEmptyWorkspace,
  demoWorkspace,
  maximumProjectCap,
  workspaceProjects,
  workspaceSnapshotSchema,
  type Project,
  type WorkspaceSnapshot,
} from "./index.js"

// A snapshot lists every active project and states the daemon's cap, while
// `project` stays the focused one, so a client built for one project keeps
// reading it unchanged.

const focused = demoWorkspace.project!
const second: Project = {
  id: "project-acme-web",
  machineId: demoWorkspace.machine.id,
  name: "acme-web",
  path: "/Users/dev/src/acme-web",
  branch: "main",
}

function rule(id: string, projectId: string): WorkspaceSnapshot["approvalRules"][number] {
  return {
    id,
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

function twoProjects(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = structuredClone(snapshot.sessions[0]!)
  session.id = "session-web"
  session.projectId = second.id
  delete session.forkedFrom
  delete session.transfer
  return {
    ...snapshot,
    projects: [focused, second],
    projectCap: 3,
    sessions: [...snapshot.sessions, session],
    approvalRules: [rule("rule-api", focused.id), rule("rule-web", second.id)],
  }
}

function issues(snapshot: unknown): string[] {
  const parsed = workspaceSnapshotSchema.safeParse(snapshot)
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe("workspace projects", () => {
  it("describes several active projects with one focused", () => {
    const snapshot = twoProjects()
    const parsed = workspaceSnapshotSchema.parse(snapshot)
    expect(parsed.projects).toEqual([focused, second])
    expect(parsed.projectCap).toBe(3)
    expect(parsed.project).toEqual(focused)
    expect(parsed.sessions.map((session) => session.projectId)).toContain(second.id)
    expect(workspaceProjects(parsed)).toEqual([focused, second])
  })

  it("requires every session to belong to an active project", () => {
    const snapshot = twoProjects()
    snapshot.projects = [focused]
    snapshot.approvalRules = snapshot.approvalRules.filter((rule) => rule.projectId === focused.id)
    expect(issues(snapshot)).toContain("Session must belong to an active project")
  })

  it("requires every approval rule to belong to an active project", () => {
    const snapshot = twoProjects()
    snapshot.approvalRules = snapshot.approvalRules.map((rule) => ({ ...rule, projectId: "project-closed" }))
    expect(issues(snapshot)).toContain("Approval rule must reference an active project")
  })

  it("requires the focused project to be one of the active projects", () => {
    const snapshot = twoProjects()
    snapshot.project = { ...focused, branch: "elsewhere" }
    expect(issues(snapshot)).toContain("The focused project must be one of the active projects")

    const missing = twoProjects()
    missing.projects = [second]
    missing.sessions = missing.sessions.filter((session) => session.projectId === second.id)
    missing.activeSessionId = "session-web"
    missing.approvalRules = missing.approvalRules.filter((rule) => rule.projectId === second.id)
    missing.thread = []
    missing.artifacts = []
    missing.workingPlans = []
    missing.annotations = []
    missing.approvals = []
    delete missing.queuedSends
    expect(issues(missing)).toEqual(["The focused project must be one of the active projects"])
  })

  it("has no focused project only when no project is active", () => {
    const snapshot = { ...createEmptyWorkspace(demoWorkspace.machine), projects: [second], projectCap: 3 }
    expect(issues(snapshot)).toContain("A workspace with active projects has a focused project")
    expect(workspaceSnapshotSchema.parse({ ...createEmptyWorkspace(demoWorkspace.machine), projects: [], projectCap: 3 }).projects).toEqual([])
  })

  it("lists each project once, on this machine, within the stated cap", () => {
    const duplicate = twoProjects()
    duplicate.projects = [focused, second, { ...second }]
    expect(issues(duplicate)).toContain("Active projects must be unique")

    const elsewhere = twoProjects()
    elsewhere.projects = [focused, { ...second, machineId: `machine-${"b".repeat(32)}` }]
    expect(issues(elsewhere)).toContain("Project must belong to the workspace machine")

    const overCap = twoProjects()
    overCap.projectCap = 1
    expect(issues(overCap)).toContain("Active projects cannot exceed the project cap")
  })

  it("bounds the project cap", () => {
    for (const projectCap of [0, 1.5, maximumProjectCap + 1]) {
      expect(workspaceSnapshotSchema.safeParse({ ...twoProjects(), projectCap }).success, String(projectCap)).toBe(false)
    }
    expect(workspaceSnapshotSchema.safeParse({ ...twoProjects(), projectCap: maximumProjectCap }).success).toBe(true)
  })

  // A snapshot written before the list, such as the daemon's stored state,
  // still parses: its one active project is the focused one.
  it("reads a snapshot without the list as its focused project alone", () => {
    const legacy = structuredClone(demoWorkspace) as Partial<WorkspaceSnapshot>
    delete legacy.projects
    delete legacy.projectCap
    const parsed = workspaceSnapshotSchema.parse(legacy)
    expect(parsed.projects).toBeUndefined()
    expect(workspaceProjects(parsed)).toEqual([focused])
    expect(workspaceProjects(createEmptyWorkspace(demoWorkspace.machine))).toEqual([])

    const foreign = structuredClone(legacy)
    foreign.sessions![0]!.projectId = second.id
    expect(issues(foreign)).toContain("Session must belong to an active project")
  })
})
