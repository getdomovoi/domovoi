import { describe, expect, it } from "vitest"

import { demoWorkspace } from "./fixtures.js"
import {
  sessionTransferCoverageSchema,
  sessionTransferPreviewSchema,
  sessionTransferStateSchema,
} from "./transfer-contract.js"

const sessionId = "session-billing"
const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`

const state = {
  version: 1 as const,
  session: {
    id: sessionId,
    title: demoWorkspace.sessions[0]!.title,
    runtime: {
      provider: "claude-code",
      model: "opus-5",
      reasoning: "high",
      permissionMode: "build" as const,
    },
    changedFiles: 7,
    testsPassed: 42,
    testsFailed: 1,
    updatedAt: "2026-09-03T18:00:00.000Z",
    baseCommit: "1".repeat(40),
    ownershipGeneration: 3,
  },
  thread: [{
    id: "thread-user",
    sessionId,
    kind: "user" as const,
    body: "Keep the replay operation idempotent.",
    createdAt: "2026-09-03T17:59:00.000Z",
  }],
  artifacts: [{
    id: "artifact-preview",
    sessionId,
    title: "Replay preview",
    type: "preview" as const,
    revision: 4,
    path: "artifacts/preview.html",
    mimeType: "text/html",
  }],
  workingPlan: {
    sessionId,
    revision: 2,
    structureRevision: 1,
    steps: [{ id: "step-1", text: "Verify replay claims", status: "in-progress" as const }],
    pendingEdit: {
      id: "edit-1",
      basedOnStructureRevision: 1,
      baseSteps: [{ id: "step-1", text: "Verify replay claims" }],
      draftSteps: [{ id: "step-1", text: "Verify every replay claim" }],
      status: "queued" as const,
      submittedAt: "2026-09-03T18:00:00.000Z",
      submittedBy: {
        client: "desktop" as const,
        connectionId: "11111111-1111-4111-8111-111111111111",
      },
    },
    createdAt: "2026-09-03T17:58:00.000Z",
    updatedAt: "2026-09-03T18:00:00.000Z",
  },
  annotations: [{
    id: "annotation-1",
    sessionId,
    artifactId: "artifact-preview",
    anchor: { textQuote: "Replay" },
    body: "Keep the status visible.",
    status: "resolved" as const,
    statusChangedBy: "desktop" as const,
    statusChangedAt: "2026-09-03T18:00:00.000Z",
    origin: "desktop" as const,
    thread: [],
    createdAt: "2026-09-03T17:59:00.000Z",
    updatedAt: "2026-09-03T18:00:00.000Z",
  }],
  usage: [{
    turnId: "turn-1",
    provider: "claude-code",
    model: "opus-5",
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 40,
    reasoningTokens: 0,
    totalTokens: 160,
    contextTokens: 1_200,
    contextWindowTokens: 200_000,
    costSource: "provider-reported" as const,
    costMicros: 2_400,
    currency: "USD",
  }],
}

const coverage = {
  included: [
    { kind: "repository" as const, count: 1 },
    { kind: "thread" as const, count: 1 },
    { kind: "artifacts" as const, count: 1 },
    { kind: "artifact-sources" as const, count: 1 },
    { kind: "annotations" as const, count: 1 },
    { kind: "working-plan" as const, count: 1 },
    { kind: "usage" as const, count: 1 },
    { kind: "runtime-settings" as const, count: 1 },
  ],
  excluded: [
    { kind: "provider-credentials" as const },
    { kind: "provider-state" as const },
    { kind: "terminals" as const },
    { kind: "approval-rules" as const },
    { kind: "skill-authority" as const },
    { kind: "audit-log" as const },
    { kind: "ignored-files" as const },
    { kind: "external-databases" as const },
    { kind: "auto" as const },
  ],
  warnings: [
    { kind: "tracked-sensitive-files-may-travel" as const },
    { kind: "promoted-ignored-artifacts" as const, count: 1 },
    { kind: "provider-restart-required" as const },
    { kind: "target-reapproval-required" as const },
  ],
}

describe("session transfer state", () => {
  it("carries one self-contained portable session aggregate", () => {
    expect(sessionTransferStateSchema.parse(state)).toEqual(state)
  })

  it("retains a pending plan edit but refuses source provider sync", () => {
    expect(sessionTransferStateSchema.parse(state).workingPlan?.pendingEdit?.status).toBe("queued")
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      workingPlan: {
        ...state.workingPlan,
        providerSync: {
          provider: "claude-code",
          model: "opus-5",
          providerThreadId: "thread-source-only",
          structureRevision: 1,
          deliveredAt: "2026-09-03T18:00:00.000Z",
        },
      },
    }).success).toBe(false)
  })

  it("refuses records from another session and broken annotation anchors", () => {
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      thread: [{ ...state.thread[0], sessionId: "session-other" }],
    }).success).toBe(false)
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      artifacts: [],
    }).success).toBe(false)
  })

  it("refuses duplicate record ids and a plan for another session", () => {
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      thread: [...state.thread, state.thread[0]],
      artifacts: [...state.artifacts, state.artifacts[0]],
      annotations: [...state.annotations, state.annotations[0]],
    }).success).toBe(false)
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      workingPlan: { ...state.workingPlan, sessionId: "session-other" },
    }).success).toBe(false)
  })

  it("refuses approval blockers because live approvals never transfer", () => {
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      workingPlan: {
        ...state.workingPlan,
        steps: [{
          ...state.workingPlan.steps[0],
          blocker: { kind: "approval", approvalId: "approval-live" },
        }],
      },
    }).success).toBe(false)
  })

  it("keeps usage numeric and refuses duplicate or incoherent turns", () => {
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      usage: [...state.usage, state.usage[0]],
    }).success).toBe(false)
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      usage: [{ ...state.usage[0], cachedInputTokens: 121 }],
    }).success).toBe(false)
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      usage: [{ ...state.usage[0], contextWindowTokens: undefined }],
    }).success).toBe(false)
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      usage: [{ ...state.usage[0], totalTokens: 1 }],
    }).success).toBe(false)
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      usage: [{ ...state.usage[0], contextTokens: 200_001 }],
    }).success).toBe(false)
    expect(sessionTransferStateSchema.safeParse({
      ...state,
      usage: [
        state.usage[0],
        { ...state.usage[0], turnId: "turn-2", currency: "EUR" },
      ],
    }).success).toBe(false)
  })
})

describe("session transfer coverage", () => {
  it("uses stable semantic keys with actual counts", () => {
    expect(sessionTransferCoverageSchema.parse(coverage)).toEqual(coverage)
  })

  it("refuses duplicate claims", () => {
    expect(sessionTransferCoverageSchema.safeParse({
      ...coverage,
      included: [...coverage.included, coverage.included[0]],
    }).success).toBe(false)
  })

  it("describes the exact preview the client approved", () => {
    const preview = {
      allowed: true as const,
      contractVersion: 1 as const,
      sessionId,
      sourceMachineId,
      targetMachineId,
      intentDigest: `sha256:${"c".repeat(64)}`,
      project: {
        sourceProjectId: "project-source",
        lineageCommit: "1".repeat(40),
        sourceHeadCommit: "2".repeat(40),
        targetProjectId: "project-target",
      },
      coverage,
    }
    expect(sessionTransferPreviewSchema.parse(preview)).toEqual(preview)
  })

  it("keeps a refused preview structured", () => {
    const preview = sessionTransferPreviewSchema.parse({
      allowed: false,
      contractVersion: 1,
      sessionId,
      sourceMachineId,
      targetMachineId,
      reason: "session-approval-pending",
      coverage,
    })
    expect(preview.allowed).toBe(false)
    if (preview.allowed) throw new Error("Expected a refused preview")
    expect(preview.reason).toBe("session-approval-pending")
  })
})
