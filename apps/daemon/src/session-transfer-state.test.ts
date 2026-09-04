import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  sessionTransferStateSchema,
  type SessionTransferUsageRecord,
} from "@getdomovoi/protocol"

import {
  importSessionTransferState,
  portableSessionTransferState,
  SessionTransferStateError,
} from "./session-transfer-state.js"

const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`
const checkpointCommit = "c".repeat(40)

function sourceWorkspace() {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.id = sourceMachineId
  snapshot.project!.machineId = sourceMachineId
  const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
  session.state = "idle"
  session.workspacePath = "/source/session-billing"
  session.baseCommit = checkpointCommit
  session.ownershipGeneration = 4
  session.runtime.auto = true
  snapshot.approvals = snapshot.approvals.filter((approval) => approval.sessionId !== session.id)
  return snapshot
}

const usage: SessionTransferUsageRecord[] = [{
  turnId: "turn-1",
  provider: "claude-code",
  model: "claude-opus-5",
  inputTokens: 20,
  cachedInputTokens: 5,
  outputTokens: 8,
  reasoningTokens: 0,
  totalTokens: 28,
  contextTokens: 64_000,
  contextWindowTokens: 200_000,
  costSource: "provider-reported",
  costMicros: 20_000,
  currency: "USD",
}]

describe("portable session transfer state", () => {
  it("carries session history and state without machine authority or provider state", () => {
    const source = sourceWorkspace()
    const state = portableSessionTransferState(source, "session-billing", usage)
    expect(sessionTransferStateSchema.parse(state)).toEqual(state)
    expect(state.session).toMatchObject({
      id: "session-billing",
      ownershipGeneration: 4,
      runtime: {
        provider: "claude-code",
        model: "sonnet-4.6",
        permissionMode: "build",
      },
    })
    expect(state.session.runtime).not.toHaveProperty("auto")
    expect(JSON.stringify(state)).not.toContain("thread-billing")
    expect(state.thread).toEqual(source.thread.filter((item) => item.sessionId === "session-billing"))
    expect(state.artifacts).toEqual(source.artifacts.filter(
      (artifact) => artifact.sessionId === "session-billing",
    ))
    expect(state.annotations).toEqual(source.annotations.filter(
      (annotation) => annotation.sessionId === "session-billing",
    ))
    expect(state.workingPlan?.pendingEdit).toEqual(source.workingPlans[0]!.pendingEdit)
    expect(state.workingPlan).not.toHaveProperty("providerSync")
    expect(state.usage).toEqual(usage)
    for (const forbidden of ["approvals", "approvalRules", "skillEnablements"]) {
      expect(state).not.toHaveProperty(forbidden)
    }
  })

  it("refuses open approvals and transfer lifecycle states", () => {
    const source = sourceWorkspace()
    source.approvals.push({
      ...demoWorkspace.approvals[0]!,
      sessionId: "session-billing",
    })
    expect(() => portableSessionTransferState(source, "session-billing", []))
      .toThrow(expect.objectContaining<Partial<SessionTransferStateError>>({
        reason: "session-approval-pending",
      }))

    source.approvals = []
    const session = source.sessions.find((candidate) => candidate.id === "session-billing")!
    session.state = "transferred"
    expect(() => portableSessionTransferState(source, "session-billing", []))
      .toThrow(expect.objectContaining<Partial<SessionTransferStateError>>({
        reason: "session-not-owned",
      }))
  })

  it("imports one idle owner, resets Auto, preserves the draft, and records the handoff", () => {
    const state = portableSessionTransferState(sourceWorkspace(), "session-billing", usage)
    const target = structuredClone(demoWorkspace)
    target.machine.id = targetMachineId
    target.project!.id = "project-target"
    target.project!.machineId = targetMachineId
    target.sessions = []
    target.thread = []
    target.artifacts = []
    target.workingPlans = []
    target.annotations = []
    target.approvals = []
    target.activeSessionId = null
    target.approvalRules = target.approvalRules.map((rule) => ({
      ...rule,
      projectId: "project-target",
    }))
    target.skillEnablements = target.skillEnablements.map((review) => ({
      ...review,
      projectId: "project-target",
    }))

    const imported = importSessionTransferState(target, state, {
      sourceMachineId,
      targetProjectId: "project-target",
      workspacePath: "/target/session-billing",
      transferId: `transfer-${"d".repeat(32)}`,
      manifestDigest: `sha256:${"e".repeat(64)}`,
      ownershipGeneration: 5,
      checkpointCommit,
      completedAt: "2026-09-03T20:00:00.000Z",
    })
    const session = imported.sessions.find((candidate) => candidate.id === "session-billing")!
    expect(session).toMatchObject({
      state: "idle",
      projectId: "project-target",
      workspacePath: "/target/session-billing",
      ownershipGeneration: 5,
      runtime: { auto: false },
    })
    expect(session).not.toHaveProperty("providerThreadId")
    expect(imported.activeSessionId).toBe("session-billing")
    expect(imported.workingPlans.find((plan) => plan.sessionId === session.id)?.pendingEdit)
      .toEqual(state.workingPlan?.pendingEdit)
    expect(imported.thread.at(-1)).toMatchObject({
      sessionId: "session-billing",
      kind: "system",
      body: `Transferred from machine ${sourceMachineId}.`,
      detail: `Ownership generation 5 arrived at checkpoint ${checkpointCommit}. Native provider state, machine authority, and automatic execution did not transfer.`,
    })
    expect(imported.approvalRules).toEqual(target.approvalRules)
    expect(imported.skillEnablements).toEqual(target.skillEnablements)
  })
})
