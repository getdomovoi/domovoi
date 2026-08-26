import { describe, expect, it } from "vitest"

import {
  approvalResolveParamsSchema,
  checkpointCreateParamsSchema,
  createEmptyWorkspace,
  demoWorkspace,
  projectOpenParamsSchema,
  providerModelSchema,
  runtimeModelsParamsSchema,
  sessionActivateParamsSchema,
  sessionCreateParamsSchema,
  sessionSendParamsSchema,
  workspaceSnapshotSchema,
} from "./index.js"

describe("workspace protocol", () => {
  it("represents a machine before a project is opened", () => {
    const empty = createEmptyWorkspace(demoWorkspace.machine)

    expect(workspaceSnapshotSchema.parse(empty)).toMatchObject({
      project: null,
      sessions: [],
      activeSessionId: null,
    })

    const inconsistent = structuredClone(empty)
    inconsistent.sessions = structuredClone(demoWorkspace.sessions)
    expect(workspaceSnapshotSchema.safeParse(inconsistent).success).toBe(false)
  })

  it("accepts the shared demo snapshot", () => {
    expect(workspaceSnapshotSchema.parse(demoWorkspace)).toEqual(demoWorkspace)
  })

  it("rejects a Build auto state represented as a fake permission mode", () => {
    const broken = structuredClone(demoWorkspace)
    broken.sessions[0]!.runtime.permissionMode = "build-auto" as "build"

    expect(workspaceSnapshotSchema.safeParse(broken).success).toBe(false)
  })

  it("requires non-empty active and thread session identifiers", () => {
    const emptyActive = structuredClone(demoWorkspace)
    emptyActive.activeSessionId = ""
    expect(workspaceSnapshotSchema.safeParse(emptyActive).success).toBe(false)

    const unscopedThread = structuredClone(demoWorkspace) as unknown as {
      thread: Array<Record<string, unknown>>
    }
    delete unscopedThread.thread[0]!.sessionId
    expect(workspaceSnapshotSchema.safeParse(unscopedThread).success).toBe(false)
  })

  it("requires an explanation for deny-explain decisions", () => {
    expect(
      approvalResolveParamsSchema.safeParse({
        approvalId: "approval-migrate",
        decision: "deny-explain",
        client: "desktop",
      }).success,
    ).toBe(false)

    expect(
      approvalResolveParamsSchema.parse({
        approvalId: "approval-migrate",
        decision: "deny-explain",
        client: "desktop",
        explanation: "Use a staging database first.",
      }).explanation,
    ).toBe("Use a staging database first.")
  })

  it("validates the local project and session lifecycle", () => {
    expect(projectOpenParamsSchema.parse({ path: "/code/domovoi", client: "desktop" })).toEqual({
      path: "/code/domovoi",
      client: "desktop",
    })
    expect(runtimeModelsParamsSchema.parse({
      provider: "codex",
      client: "desktop",
    }).provider).toBe("codex")
    expect(providerModelSchema.parse({
      provider: "codex",
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Coding model",
      supportedReasoningEfforts: ["none", "medium", "xhigh", "max"],
      defaultReasoningEffort: "xhigh",
      isDefault: true,
    }).id).toBe("gpt-5.6-sol")
    expect(providerModelSchema.safeParse({
      provider: "codex",
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Coding model",
      supportedReasoningEfforts: ["   "],
      defaultReasoningEffort: "medium",
      isDefault: true,
    }).success).toBe(false)
    expect(providerModelSchema.safeParse({
      provider: "codex",
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Coding model",
      supportedReasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "high",
      isDefault: true,
    }).success).toBe(false)
    expect(sessionCreateParamsSchema.parse({
      title: "Add persistence",
      runtime: demoWorkspace.sessions[0]!.runtime,
      client: "desktop",
    }).title).toBe("Add persistence")
    expect(sessionActivateParamsSchema.parse({
      sessionId: "session-1",
      client: "desktop",
    }).sessionId).toBe("session-1")
    expect(sessionSendParamsSchema.parse({
      sessionId: "session-1",
      prompt: "Run the tests",
      client: "desktop",
    }).prompt).toBe("Run the tests")
    expect(checkpointCreateParamsSchema.parse({
      sessionId: "session-1",
      label: "before-turn",
      client: "desktop",
    }).label).toBe("before-turn")
  })
})
