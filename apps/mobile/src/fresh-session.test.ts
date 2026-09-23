import { demoWorkspace, type RuntimeDiscoverResult, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it, vi } from "vitest"

import { freshSessionReadiness, startFreshSession } from "./fresh-session"

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

    const sessionId = await startFreshSession(snapshot, "Cover the claim-expiry case", call)

    expect(sessionId).toBe("session-new")
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "runtime.discover",
      "session.create",
      "session.send",
    ])
    expect(call).not.toHaveBeenCalledWith("project.open", expect.anything())
    expect(call.mock.calls[1]?.[1]).toMatchObject({ runtime: discovery.defaultRuntime, client: "phone" })
    expect(call.mock.calls[2]?.[1]).toEqual({
      sessionId: "session-new",
      prompt: "Cover the claim-expiry case",
      client: "phone",
    })
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
})
