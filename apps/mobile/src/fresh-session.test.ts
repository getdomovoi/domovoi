import { demoWorkspace, type RuntimeDiscoverResult, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it, vi } from "vitest"

import { defaultFreshProjectId, freshSessionReadiness, startFreshSession } from "./fresh-session"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("fresh session start", () => {
  it("uses the current project and discovered default runtime without opening a project", async () => {
    const snapshot = workspace()
    const runtime = snapshot.sessions[0]?.runtime
    if (!runtime) throw new Error("fixture needs a runtime")
    snapshot.machine.providers = [{
      id: runtime.provider,
      command: runtime.provider,
      status: "ready",
      sessionCapable: true,
    }]
    const discovery: RuntimeDiscoverResult = {
      machineId: snapshot.machine.id,
      provider: runtime.provider,
      status: "ready",
      models: [{
        provider: runtime.provider,
        id: runtime.model,
        displayName: runtime.model,
        description: "",
        supportedReasoningEfforts: [runtime.reasoning],
        defaultReasoningEffort: runtime.reasoning,
        isDefault: true,
      }],
      defaultRuntime: runtime,
      permissionModes: [runtime.permissionMode],
      supportsAuto: runtime.permissionMode === "build",
    }
    const sourceSession = snapshot.sessions[0]
    if (!sourceSession) throw new Error("fixture needs a source session")
    const created = {
      ...snapshot,
      sessions: [...snapshot.sessions, { ...sourceSession, id: "session-new", title: "Cover the claim-expiry case" }],
      activeSessionId: "session-new",
    }
    const call = vi.fn(async (method: string, _params: unknown) => method === "runtime.discover" ? discovery : created)

    const sessionId = await startFreshSession(snapshot, "Cover the claim-expiry case", call, "phone")

    expect(sessionId).toBe("session-new")
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "runtime.discover",
      "session.create",
      "session.send",
    ])
    expect(call).not.toHaveBeenCalledWith("project.open", expect.anything())
    expect(call.mock.calls[1]?.[1]).toMatchObject({ runtime: discovery.defaultRuntime, client: "phone", projectId: snapshot.project!.id })
    // A session made a moment ago has no comment, and the send says so
    // (ruling Q402: the daemon attaches only what a message names).
    expect(call.mock.calls[2]?.[1]).toEqual({
      sessionId: "session-new",
      prompt: "Cover the claim-expiry case",
      client: "phone",
      review: { annotationIds: [] },
    })

    // A credential paired from a tablet code greets as a tablet, and the
    // daemon refuses any later call that names another kind.
    call.mockClear()
    await startFreshSession(snapshot, "Cover the claim-expiry case", call, "tablet")
    expect(call.mock.calls.map(([, params]) => (params as { client: string }).client)).toEqual(["tablet", "tablet", "tablet"])
  })

  it("keeps the action visible but disabled with the project reason", () => {
    const snapshot = workspace()
    snapshot.project = null
    snapshot.sessions = []
    snapshot.activeSessionId = null
    snapshot.approvals = []
    snapshot.approvalRules = []
    snapshot.thread = []
    snapshot.artifacts = []
    snapshot.workingPlans = []
    snapshot.annotations = []
    snapshot.skillEnablements = []

    expect(freshSessionReadiness(snapshot)).toEqual({
      canStart: false,
      reason: "Open a project on the machine before starting a session.",
    })
  })

  // The desktop labels a provider with a problem "Cannot start"; the phone must
  // not choose it either, even when it reports ready.
  it("skips a ready provider the daemon says cannot start, and starts the next one", async () => {
    const snapshot = workspace()
    const outdated = "Update Claude Code to 2.1.263 or newer. The claude on this machine is 2.1.100."
    snapshot.machine.providers = [
      { id: "claude-code", command: "claude", status: "ready", sessionCapable: true, version: "2.1.100", problem: outdated },
      { id: "codex", command: "codex", status: "ready", sessionCapable: true },
    ]
    // Stops at the first call; the test is which provider it asked about.
    const call = vi.fn(async (_method: string, _params: unknown) => { throw new Error("stop here") })

    await expect(startFreshSession(snapshot, "Go", call, "phone")).rejects.toThrow("stop here")
    expect(call.mock.calls[0]?.[1]).toMatchObject({ provider: "codex" })
  })

  it("says why when the only ready provider cannot start", () => {
    const snapshot = workspace()
    const outdated = "Update Claude Code to 2.1.263 or newer. The claude on this machine is 2.1.100."
    snapshot.machine.providers = [
      { id: "claude-code", command: "claude", status: "ready", sessionCapable: true, version: "2.1.100", problem: outdated },
    ]

    expect(freshSessionReadiness(snapshot)).toEqual({ canStart: false, reason: outdated })
  })
})


describe("fresh session project", () => {
  it("defaults to the source session project, otherwise the focused project", () => {
    const snapshot = workspace()
    const b = { ...snapshot.project!, id: "project-b", name: "Project B" }
    snapshot.projects = [snapshot.project!, b]
    snapshot.sessions[0]!.projectId = b.id
    expect(defaultFreshProjectId(snapshot, snapshot.sessions[0]!.id)).toBe(b.id)
    expect(defaultFreshProjectId(snapshot)).toBe(snapshot.project!.id)
    expect(defaultFreshProjectId(snapshot, "removed-session")).toBe(snapshot.project!.id)
  })

  it.each([
    ["folder-missing", "The project folder was not found. A session cannot start here."],
    ["folder-check-failed", "The project folder could not be checked. A session cannot start here."],
  ] as const)("blocks only the chosen project when %s", async (unavailableReason, reason) => {
    const snapshot = workspace()
    snapshot.machine.providers = [{ id: "codex", command: "codex", status: "ready", sessionCapable: true }]
    const b = { ...snapshot.project!, id: "project-b", name: "Project B", unavailableReason }
    snapshot.projects = [snapshot.project!, b]
    expect(freshSessionReadiness(snapshot, b.id)).toEqual({ canStart: false, reason })
    expect(freshSessionReadiness(snapshot, snapshot.project!.id).canStart).toBe(true)
    const call = vi.fn(async () => ({}))
    await expect(startFreshSession(snapshot, "Go", call, "phone", b.id)).rejects.toThrow(reason)
    expect(call).not.toHaveBeenCalled()
  })

  it("does not substitute the focused project when the chosen project closes", async () => {
    const snapshot = workspace()
    const call = vi.fn(async () => ({}))
    await expect(startFreshSession(snapshot, "Go", call, "phone", "project-closed"))
      .rejects.toThrow("This project is no longer active. Choose an active project.")
    expect(call).not.toHaveBeenCalled()
  })
})
