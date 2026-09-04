import { describe, expect, it } from "vitest"

import {
  annotationSchema,
  annotationCreateParamsSchema,
  annotationReplyParamsSchema,
  annotationSetStatusParamsSchema,
  annotationVisualContextSchema,
  artifactAuthorizeParamsSchema,
  artifactAuthorizeResultSchema,
  approvalResolveParamsSchema,
  checkpointCreateParamsSchema,
  checkpointRestoreParamsSchema,
  createEmptyWorkspace,
  daemonShuttingDownErrorCode,
  demoWorkspace,
  projectOpenParamsSchema,
  providerModelSchema,
  providerFailureSchema,
  providerRuntimeSchema,
  helloParamsSchema,
  sessionHistoryPageSchema,
  sessionHistoryParamsSchema,
  maximumWorkspaceDeltaChunkLength,
  maximumSessionHistoryPageItems,
  maximumTerminalOutputChunkCharacters,
  runtimeModelsParamsSchema,
  systemPauseAllParamsSchema,
  terminalCloseParamsSchema,
  terminalClaimParamsSchema,
  terminalCreateParamsSchema,
  terminalInputParamsSchema,
  terminalOwnershipNotificationSchema,
  terminalResizeParamsSchema,
  terminalSessionSchema,
  terminalOutputNotificationSchema,
  previewBridgePickerMessageSchema,
  previewBridgeResolveAnchorsMessageSchema,
  previewBridgeAnchorResolutionsMessageSchema,
  previewBridgeSelectionMessageSchema,
  annotationAnchorSchema,
  clientIdentityIdSchema,
  reasoningEffortSchema,
  runtimeSchema,
  terminalOwnerSchema,
  sessionActivateParamsSchema,
  sessionArchiveParamsSchema,
  sessionCreateParamsSchema,
  sessionForkParamsSchema,
  sessionPauseParamsSchema,
  sessionSendParamsSchema,
  skillSummarySchema,
  skillDocumentSchema,
  workspaceSnapshotSchema,
  workspaceDeltaSchema,
  artifactSchema,
  threadItemSchema,
  type WorkingPlan,
} from "./index.js"

const skillSecurityMetadata = {
  manifest: { version: 1 as const, capabilities: [] },
  contentDigest: `sha256:${"a".repeat(64)}`,
  signature: { state: "unsigned" as const },
  trust: { state: "untrusted" as const, reason: "unsigned" as const },
}

describe("workspace protocol", () => {
  const workingPlan: WorkingPlan = {
    sessionId: "session-billing",
    revision: 7,
    structureRevision: 3,
    steps: [
      {
        id: "plan-step-schema",
        text: "Add the replay table",
        status: "completed",
      },
      {
        id: "plan-step-migrate",
        text: "Apply the migration",
        status: "in-progress",
        blocker: { kind: "approval", approvalId: "approval-migrate" },
      },
    ],
    providerSync: {
      provider: "claude-code",
      model: "sonnet-4.6",
      providerThreadId: "thread-billing",
      structureRevision: 2,
      deliveredAt: "2026-08-25T21:50:00.000Z",
    },
    pendingEdit: {
      id: "plan-edit-reorder",
      basedOnStructureRevision: 2,
      baseSteps: [
        { id: "plan-step-schema", text: "Add the replay table" },
        { id: "plan-step-migrate", text: "Run the migration" },
      ],
      draftSteps: [
        { id: "plan-step-migrate", text: "Run the migration in staging" },
        { id: "plan-step-schema", text: "Add the replay table" },
      ],
      status: "conflicted",
      submittedAt: "2026-08-25T21:51:00.000Z",
      submittedBy: {
        client: "desktop",
        connectionId: "11111111-1111-4111-8111-111111111111",
        clientId: "desktop-primary",
      },
    },
    createdAt: "2026-08-25T21:45:00.000Z",
    updatedAt: "2026-08-25T21:52:00.000Z",
  }

  it("defaults structured working plans for older snapshots", () => {
    const legacy = structuredClone(demoWorkspace) as unknown as Record<string, unknown>
    delete legacy.workingPlans

    const parsed = workspaceSnapshotSchema.parse(legacy) as unknown as Record<string, unknown>
    expect(parsed.workingPlans).toEqual([])
  })

  it("retains a conflicted working-plan draft for explicit resolution", () => {
    const snapshot = {
      ...structuredClone(demoWorkspace),
      workingPlans: [workingPlan],
    }

    const parsed = workspaceSnapshotSchema.parse(snapshot) as unknown as {
      workingPlans?: unknown[]
    }
    expect(parsed.workingPlans).toEqual([workingPlan])
  })

  it("rejects a blocker on a completed working-plan step", () => {
    const blockedCompleted = structuredClone(workingPlan)
    blockedCompleted.steps[0]!.blocker = {
      kind: "approval",
      approvalId: "approval-migrate",
    }

    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [blockedCompleted],
    }).success).toBe(false)
  })

  it("keeps working-plan blockers reference-only", () => {
    const messageBearing = structuredClone(workingPlan) as unknown as {
      steps: Array<{ blocker?: Record<string, unknown> }>
    }
    messageBearing.steps[1]!.blocker!.message = "Paste TOKEN=secret to continue"

    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [messageBearing],
    }).success).toBe(false)
  })

  it("bounds durable working-plan step text", () => {
    const oversized = structuredClone(workingPlan)
    oversized.steps[0]!.text = "x".repeat(4_097)

    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [oversized],
    }).success).toBe(false)
  })

  it("does not present inferred files as working-plan facts", () => {
    const inferredFiles = structuredClone(workingPlan) as unknown as {
      steps: Array<Record<string, unknown>>
    }
    inferredFiles.steps[0]!.files = ["src/replay.ts"]

    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [inferredFiles],
    }).success).toBe(false)
  })

  it("accepts a queued structural draft only against the current structure", () => {
    const queued = structuredClone(workingPlan)
    queued.pendingEdit = {
      ...queued.pendingEdit!,
      basedOnStructureRevision: queued.structureRevision,
      baseSteps: queued.steps.map(({ id, text }) => ({ id, text })),
      status: "queued",
    }

    expect(workspaceSnapshotSchema.parse({
      ...structuredClone(demoWorkspace),
      workingPlans: [queued],
    }).workingPlans).toEqual([queued])

    queued.pendingEdit.baseSteps[0]!.text = "An outdated title"
    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [queued],
    }).success).toBe(false)
  })

  it("represents a first human-authored plan queued behind an active turn", () => {
    const initial: WorkingPlan = {
      sessionId: "session-onboarding",
      revision: 1,
      structureRevision: 0,
      steps: [],
      pendingEdit: {
        id: "plan-edit-first",
        basedOnStructureRevision: 0,
        baseSteps: [],
        draftSteps: [{ id: "plan-step-first", text: "Inspect the empty state" }],
        status: "queued",
        submittedAt: "2026-08-25T21:51:00.000Z",
        submittedBy: {
          client: "desktop",
          connectionId: "11111111-1111-4111-8111-111111111111",
        },
      },
      createdAt: "2026-08-25T21:51:00.000Z",
      updatedAt: "2026-08-25T21:51:00.000Z",
    }

    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [...demoWorkspace.workingPlans, initial],
    }).success).toBe(true)
  })

  it.each([
    ["plan revision", (plan: WorkingPlan) => {
      plan.revision = plan.structureRevision - 1
    }],
    ["provider sync", (plan: WorkingPlan) => {
      plan.providerSync!.structureRevision = plan.structureRevision + 1
    }],
    ["conflicted edit revision", (plan: WorkingPlan) => {
      plan.pendingEdit!.basedOnStructureRevision = plan.structureRevision
    }],
    ["canonical step id", (plan: WorkingPlan) => {
      plan.steps[1]!.id = plan.steps[0]!.id
    }],
    ["draft step id", (plan: WorkingPlan) => {
      plan.pendingEdit!.draftSteps[1]!.id = plan.pendingEdit!.draftSteps[0]!.id
    }],
  ] as const)("rejects an invalid working-plan %s", (_label, mutate) => {
    const plan = structuredClone(workingPlan)
    mutate(plan)

    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [plan],
    }).success).toBe(false)
  })

  it("bounds total working-plan text and step count", () => {
    const aggregate = structuredClone(workingPlan)
    aggregate.steps = Array.from({ length: 17 }, (_, index) => ({
      id: `step-${index}`,
      text: "x".repeat(4_096),
      status: "pending" as const,
    }))
    delete aggregate.pendingEdit
    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [aggregate],
    }).success).toBe(false)

    aggregate.steps = Array.from({ length: 129 }, (_, index) => ({
      id: `step-${index}`,
      text: "bounded",
      status: "pending" as const,
    }))
    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [aggregate],
    }).success).toBe(false)
  })

  it("requires working plans and blockers to stay inside one session", () => {
    const missingApproval = structuredClone(workingPlan)
    missingApproval.steps[1]!.blocker!.approvalId = "approval-missing"
    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [missingApproval],
    }).success).toBe(false)

    const missingSession = structuredClone(workingPlan)
    missingSession.sessionId = "session-missing"
    expect(workspaceSnapshotSchema.safeParse({
      ...structuredClone(demoWorkspace),
      workingPlans: [missingSession],
    }).success).toBe(false)

    const duplicate = structuredClone(demoWorkspace)
    duplicate.workingPlans.push(structuredClone(workingPlan))
    expect(workspaceSnapshotSchema.safeParse(duplicate).success).toBe(false)
  })

  it("bounds terminal output notification payloads", () => {
    expect(terminalOutputNotificationSchema.safeParse({
      terminalId: "terminal-1",
      data: "x".repeat(maximumTerminalOutputChunkCharacters),
    }).success).toBe(true)
    expect(terminalOutputNotificationSchema.safeParse({
      terminalId: "terminal-1",
      data: "x".repeat(maximumTerminalOutputChunkCharacters + 1),
    }).success).toBe(false)
  })
  it("keeps preview variant metadata bounded and reference-only", () => {
    const variant = { id: "a", groupId: "design-studio/onboarding", label: "Variant A", order: 0 }
    expect(artifactSchema.parse({
      id: "preview-a", sessionId: "session-a", title: "Variant A", type: "preview",
      revision: 2, path: "design-studio/onboarding/variant-a.html", mimeType: "text/html",
      variant: { ...variant,
        thumbnail: { path: "design-studio/onboarding/variant-a.webp", mimeType: "image/webp", revision: 2 } },
    }).variant).toEqual(variant)
    for (const invalid of [{ label: "x".repeat(121) }, { order: 1_024 }, { id: "" }]) {
      expect(artifactSchema.safeParse({
        id: "preview-a", sessionId: "session-a", title: "Variant A", type: "preview", revision: 1,
        variant: { ...variant, ...invalid },
      }).success, JSON.stringify(invalid)).toBe(false)
    }
  })

  it("carries command tool rows and still reads a retired file-change row", () => {
    const tool = {
      id: "tool-1", sessionId: "session-a", kind: "tool", status: "completed",
      title: "pnpm test", createdAt: "2026-08-25T22:00:00.000Z",
    }
    expect(threadItemSchema.safeParse({ ...tool, tool: "command" }).success).toBe(true)
    // Nothing emits it, but a snapshot written before it was retired must still
    // load rather than failing the daemon on startup.
    expect(threadItemSchema.safeParse({ ...tool, tool: "file-change" }).success).toBe(true)
    expect(threadItemSchema.safeParse({ ...tool, tool: "invented" }).success).toBe(false)
  })

  it("defaults durable skill reviews for older snapshots", () => {
    const legacy = structuredClone(demoWorkspace) as unknown as Record<string, unknown>
    delete legacy.skillEnablements

    expect(workspaceSnapshotSchema.parse(legacy).skillEnablements).toEqual([])
  })

  it("keeps one review per project and skill", () => {
    const review = {
      projectId: "project-one",
      skillId: "skill-111111111111",
      enabled: true,
      contentDigest: `sha256:${"a".repeat(64)}`,
      manifest: { version: 1 as const, capabilities: [] },
      reviewedAt: "2026-08-30T12:00:00.000Z",
      reviewedBy: { client: "desktop" as const },
    }
    expect(workspaceSnapshotSchema.safeParse({
      ...demoWorkspace,
      skillEnablements: [review, { ...review }],
    }).success).toBe(false)
    expect(workspaceSnapshotSchema.safeParse({
      ...demoWorkspace,
      skillEnablements: [review, { ...review, projectId: "project-two" }],
    }).success).toBe(true)
  })
  it("keeps provider failures typed, safe, and actionable", () => {
    const failures = [
      ["authentication-expired", "sign-in", "Provider authentication expired", false],
      ["rate-limit", "retry", "Provider rate limit reached", true],
      ["quota-exhausted", "check-quota", "Provider quota is exhausted", false],
      ["model-unavailable", "change-model", "Selected model is unavailable", false],
      ["context-window-exceeded", "shorten-context", "Turn exceeded the model context window", false],
      ["transport", "retry", "Provider connection failed", true],
      ["unknown", "retry", "Provider request failed", true],
    ] as const

    for (const [kind, action, message, retryable] of failures) {
      expect(providerFailureSchema.parse({ kind, action, message, retryable })).toEqual({
        kind,
        action,
        message,
        retryable,
      })
    }
    expect(providerFailureSchema.safeParse({
      kind: "context-window-exceeded",
      action: "retry",
      message: "Turn exceeded the model context window",
      retryable: true,
    }).success).toBe(false)
    expect(providerFailureSchema.safeParse({
      kind: "authentication-expired",
      action: "sign-in",
      message: "token=super-secret",
      retryable: false,
    }).success).toBe(false)

    const snapshot = structuredClone(demoWorkspace)
    snapshot.sessions[0]!.providerFailure = failures[0] && {
      kind: failures[0][0],
      action: failures[0][1],
      message: failures[0][2],
      retryable: failures[0][3],
    }
    expect(workspaceSnapshotSchema.parse(snapshot).sessions[0]!.providerFailure)
      .toEqual(snapshot.sessions[0]!.providerFailure)
  })

  it("validates fork provenance and unique idempotency keys", () => {
    const snapshot = structuredClone(demoWorkspace)
    const source = snapshot.sessions[0]!
    const checkpoint = snapshot.thread.find((item) =>
      item.sessionId === source.id && item.kind === "checkpoint"
    )!
    if (checkpoint.kind !== "checkpoint" || !checkpoint.commit) throw new Error("fixture checkpoint missing")
    const fork = {
      ...source,
      id: "session-fork",
      title: "Forked session",
      providerThreadId: "provider-thread-fork",
      workspacePath: "/worktrees/session-fork",
      baseCommit: checkpoint.commit,
      forkedFrom: {
        sourceSessionId: source.id,
        checkpointId: checkpoint.id,
        checkpointCommit: checkpoint.commit,
        requestId: "fork-request-1",
        client: "desktop" as const,
        requestedRuntime: source.runtime,
      },
    }
    snapshot.sessions.push(fork)
    expect(workspaceSnapshotSchema.parse(snapshot).sessions.at(-1)?.forkedFrom).toEqual(fork.forkedFrom)

    const unknownSource = structuredClone(snapshot)
    unknownSource.sessions.at(-1)!.forkedFrom!.sourceSessionId = "session-missing"
    expect(workspaceSnapshotSchema.safeParse(unknownSource).success).toBe(false)

    const wrongCheckpointOwner = structuredClone(snapshot)
    wrongCheckpointOwner.sessions.at(-1)!.forkedFrom!.sourceSessionId = snapshot.sessions[1]!.id
    expect(workspaceSnapshotSchema.safeParse(wrongCheckpointOwner).success).toBe(false)

    const duplicateRequest = structuredClone(snapshot)
    duplicateRequest.sessions.push({
      ...fork,
      id: "session-fork-duplicate",
      workspacePath: "/worktrees/session-fork-duplicate",
      providerThreadId: "provider-thread-fork-duplicate",
    })
    expect(workspaceSnapshotSchema.safeParse(duplicateRequest).success).toBe(false)

    const truncated = structuredClone(snapshot)
    truncated.thread = truncated.thread.filter((item) => item.id !== checkpoint.id)
    const missingCheckpoint = workspaceSnapshotSchema.safeParse(truncated)
    expect(missingCheckpoint.success).toBe(false)
    if (!missingCheckpoint.success) expect(missingCheckpoint.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Fork checkpoint must exist unless snapshot history is truncated",
        }),
      ]),
    )
    const truncatedClient = { ...truncated, historyTruncated: true }
    expect(workspaceSnapshotSchema.safeParse(truncatedClient).success).toBe(true)

    const presentMismatch = structuredClone(truncatedClient)
    presentMismatch.thread.push({ ...checkpoint, sessionId: snapshot.sessions[1]!.id })
    expect(workspaceSnapshotSchema.safeParse(presentMismatch).success).toBe(false)

    const imported = structuredClone(snapshot)
    const importedFork = imported.sessions.at(-1)!
    importedFork.forkedFrom = {
      ...importedFork.forkedFrom!,
      sourceSessionId: "session-on-source-machine",
      sourceMachineId: `machine-${"a".repeat(32)}`,
      checkpointId: "checkpoint-on-source-machine",
    }
    expect(workspaceSnapshotSchema.safeParse(imported).success).toBe(true)
  })

  it("models durable session archive lifecycle and requests", () => {
    expect(sessionArchiveParamsSchema.parse({
      sessionId: "session-billing",
      client: "web",
    })).toEqual({ sessionId: "session-billing", client: "web" })

    const archiving = structuredClone(demoWorkspace)
    archiving.sessions[0]!.state = "archiving"
    archiving.sessions[0]!.archiveRequestedAt = "2026-08-29T12:00:00.000Z"
    expect(workspaceSnapshotSchema.parse(archiving).sessions[0]).toMatchObject({
      state: "archiving",
      archiveRequestedAt: "2026-08-29T12:00:00.000Z",
    })

    const archived = structuredClone(archiving)
    archived.sessions[0]!.state = "archived"
    archived.sessions[0]!.archivedAt = "2026-08-29T12:01:00.000Z"
    archived.sessions[0]!.archiveCheckpoint = "a".repeat(40)
    delete archived.sessions[0]!.workspacePath
    delete archived.sessions[0]!.providerThreadId
    delete archived.sessions[0]!.activeTurnId
    expect(workspaceSnapshotSchema.parse(archived).sessions[0]).toMatchObject({
      state: "archived",
      archiveCheckpoint: "a".repeat(40),
    })
    const expectArchiveIssue = (
      snapshot: typeof archived,
      replacement: (typeof archived.sessions)[number],
      field: string,
    ) => {
      const parsed = workspaceSnapshotSchema.safeParse({
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.id === replacement.id ? replacement : session
        ),
      })
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["sessions", 0, field] }),
      ]))
    }
    expectArchiveIssue(
      archiving,
      { ...archiving.sessions[0]!, archiveRequestedAt: undefined },
      "archiveRequestedAt",
    )
    expectArchiveIssue(
      archived,
      { ...archived.sessions[0]!, archivedAt: undefined },
      "archivedAt",
    )
    expectArchiveIssue(
      archived,
      { ...archived.sessions[0]!, workspacePath: "/worktrees/stale" },
      "workspacePath",
    )
    expectArchiveIssue(
      archived,
      {
        ...archived.sessions[0]!,
        state: "idle",
        archiveRequestedAt: "2026-08-29T12:00:00.000Z",
      },
      "state",
    )
  })

  it("models a frozen source while session ownership moves", () => {
    const transferring = structuredClone(demoWorkspace)
    const session = transferring.sessions[2]!
    session.state = "transferring"
    session.workspacePath = "/worktrees/session-audit"
    session.baseCommit = "a".repeat(40)
    session.ownershipGeneration = 3
    session.transfer = {
      phase: "transferring",
      transferId: `transfer-${"b".repeat(32)}`,
      targetMachineId: `machine-${"c".repeat(32)}`,
      intentDigest: `sha256:${"d".repeat(64)}`,
      nextGeneration: 4,
      startedAt: "2026-09-03T18:00:00.000Z",
      package: { state: "preparing" },
    }
    expect(workspaceSnapshotSchema.parse(transferring).sessions[2]).toMatchObject({
      state: "transferring",
      ownershipGeneration: 3,
      transfer: { phase: "transferring", nextGeneration: 4 },
    })

    const wrongGeneration = structuredClone(transferring)
    if (wrongGeneration.sessions[2]!.transfer?.phase !== "transferring") {
      throw new Error("Expected a transfer in progress")
    }
    wrongGeneration.sessions[2]!.transfer.nextGeneration = 5
    expect(workspaceSnapshotSchema.safeParse(wrongGeneration).success).toBe(false)
    const unstagedWithoutPackage = structuredClone(transferring)
    delete (unstagedWithoutPackage.sessions[2]!.transfer as { package?: unknown }).package
    expect(workspaceSnapshotSchema.safeParse(unstagedWithoutPackage).success).toBe(false)

    const transferred = structuredClone(transferring)
    transferred.sessions[2]!.state = "transferred"
    transferred.sessions[2]!.ownershipGeneration = 4
    transferred.sessions[2]!.transfer = {
      phase: "transferred",
      transferId: `transfer-${"b".repeat(32)}`,
      targetMachineId: `machine-${"c".repeat(32)}`,
      generation: 4,
      manifestDigest: `sha256:${"e".repeat(64)}`,
      completedAt: "2026-09-03T18:01:00.000Z",
    }
    delete transferred.sessions[2]!.providerThreadId
    delete transferred.sessions[2]!.activeTurnId
    delete transferred.sessions[2]!.providerFailure
    expect(workspaceSnapshotSchema.parse(transferred).sessions[2]).toMatchObject({
      state: "transferred",
      transfer: { phase: "transferred", generation: 4 },
    })

    const imported = structuredClone(demoWorkspace)
    const importedMachineId = `machine-${"1".repeat(32)}`
    imported.machine.id = importedMachineId
    imported.project!.machineId = importedMachineId
    imported.sessions[2]!.ownershipGeneration = 4
    imported.sessions[2]!.transferredFrom = {
      transferId: `transfer-${"e".repeat(32)}`,
      sourceMachineId: `machine-${"f".repeat(32)}`,
      generation: 4,
      manifestDigest: `sha256:${"1".repeat(64)}`,
      checkpointCommit: "a".repeat(40),
      completedAt: "2026-09-03T18:01:00.000Z",
    }
    expect(workspaceSnapshotSchema.parse(imported).sessions[2]?.transferredFrom)
      .toEqual(imported.sessions[2]?.transferredFrom)
    const newerProvenance = structuredClone(imported)
    newerProvenance.sessions[2]!.transferredFrom!.generation = 5
    expect(workspaceSnapshotSchema.safeParse(newerProvenance).success).toBe(false)
    const missingOwnership = structuredClone(imported)
    delete missingOwnership.sessions[2]!.ownershipGeneration
    expect(workspaceSnapshotSchema.safeParse(missingOwnership).success).toBe(false)
    const sameMachine = structuredClone(imported)
    sameMachine.sessions[2]!.transferredFrom!.sourceMachineId = importedMachineId
    expect(workspaceSnapshotSchema.safeParse(sameMachine).success).toBe(false)
    const missingManifestIdentity = structuredClone(imported)
    delete (missingManifestIdentity.sessions[2]!.transferredFrom as { manifestDigest?: unknown })
      .manifestDigest
    expect(workspaceSnapshotSchema.safeParse(missingManifestIdentity).success).toBe(false)

    const liveProvider = structuredClone(transferred)
    liveProvider.sessions[2]!.providerThreadId = "thread-still-live"
    expect(workspaceSnapshotSchema.safeParse(liveProvider).success).toBe(false)

    const missingLifecycle = structuredClone(transferred)
    delete missingLifecycle.sessions[2]!.transfer
    expect(workspaceSnapshotSchema.safeParse(missingLifecycle).success).toBe(false)
  })

  it("retains an attributed source recovery and freezes the claimant on detected conflict", () => {
    const recovered = structuredClone(demoWorkspace)
    const session = recovered.sessions[2]!
    session.state = "idle"
    session.workspacePath = "/worktrees/session-audit"
    session.ownershipGeneration = 3
    delete session.activeTurnId
    session.sourceRecovery = {
      transferId: `transfer-${"a".repeat(32)}`,
      targetMachineId: `machine-${"b".repeat(32)}`,
      generation: 3,
      recoveredAt: "2026-09-03T18:10:00.000Z",
      decidedBy: { client: "desktop", clientId: "studio-mac" },
    }
    expect(workspaceSnapshotSchema.parse(recovered).sessions[2]?.sourceRecovery)
      .toEqual(session.sourceRecovery)

    const conflicted = structuredClone(recovered)
    conflicted.sessions[2]!.state = "ownership-conflict"
    conflicted.sessions[2]!.ownershipConflict = {
      transferId: session.sourceRecovery.transferId,
      otherMachineId: session.sourceRecovery.targetMachineId,
      otherGeneration: 4,
      detectedAt: "2026-09-03T19:00:00.000Z",
      recoveryAction: "none",
    }
    expect(workspaceSnapshotSchema.parse(conflicted).sessions[2]).toMatchObject({
      state: "ownership-conflict",
      ownershipConflict: { otherGeneration: 4, recoveryAction: "none" },
    })

    const hiddenConflict = structuredClone(conflicted)
    hiddenConflict.sessions[2]!.state = "idle"
    expect(workspaceSnapshotSchema.safeParse(hiddenConflict).success).toBe(false)
    const unexplainedConflict = structuredClone(conflicted)
    delete unexplainedConflict.sessions[2]!.sourceRecovery
    expect(workspaceSnapshotSchema.safeParse(unexplainedConflict).success).toBe(false)
    const runnableConflict = structuredClone(conflicted)
    runnableConflict.sessions[2]!.activeTurnId = "turn-after-conflict"
    expect(workspaceSnapshotSchema.safeParse(runnableConflict).success).toBe(false)
    const staleClaim = structuredClone(recovered)
    staleClaim.sessions[2]!.sourceRecovery!.generation = 4
    expect(workspaceSnapshotSchema.safeParse(staleClaim).success).toBe(false)
    const selfClaim = structuredClone(recovered)
    selfClaim.sessions[2]!.sourceRecovery!.targetMachineId = recovered.machine.id
    expect(workspaceSnapshotSchema.safeParse(selfClaim).success).toBe(false)
    const selfConflict = structuredClone(conflicted)
    selfConflict.sessions[2]!.ownershipConflict!.otherMachineId = conflicted.machine.id
    expect(workspaceSnapshotSchema.safeParse(selfConflict).success).toBe(false)
    const conflictOnIdle = structuredClone(recovered)
    conflictOnIdle.sessions[2]!.ownershipConflict = conflicted.sessions[2]!.ownershipConflict
    expect(workspaceSnapshotSchema.safeParse(conflictOnIdle).success).toBe(false)
  })

  it("reserves a stable daemon shutdown error code", () => {
    expect(daemonShuttingDownErrorCode).toBe(-32002)
  })

  it("bounds cursor-based session history pages", () => {
    const session = demoWorkspace.sessions[0]!
    const source = demoWorkspace.thread.find((candidate) =>
      candidate.sessionId === session.id && candidate.kind === "user"
    )!
    const item = {
      id: `thread:${source.id}`,
      sourceId: source.id,
      sessionId: source.sessionId,
      category: "messages" as const,
      role: "user" as const,
      body: source.kind === "user" ? source.body : "",
      createdAt: source.createdAt,
    }

    expect(sessionHistoryParamsSchema.parse({
      sessionId: session.id,
      before: item.id,
      limit: 50,
    })).toEqual({ sessionId: session.id, before: item.id, limit: 50 })
    expect(sessionHistoryParamsSchema.safeParse({
      sessionId: session.id,
      limit: maximumSessionHistoryPageItems + 1,
    }).success).toBe(false)
    expect(sessionHistoryPageSchema.safeParse({
      sessionId: session.id,
      items: Array.from({ length: maximumSessionHistoryPageItems + 1 }, (_, index) => ({
        ...item,
        id: `thread:message-${index}`,
        sourceId: `message-${index}`,
      })),
      hasMore: false,
    }).success).toBe(false)
    expect(sessionHistoryPageSchema.parse({
      sessionId: session.id,
      items: [item],
      hasMore: true,
      nextCursor: item.id,
    }).nextCursor).toBe(item.id)
  })

  it("validates bounded session workspace deltas", () => {
    const session = demoWorkspace.sessions[0]!
    expect(workspaceDeltaSchema.parse({
      sessionId: session.id,
      updatedAt: session.updatedAt,
      operations: [{
        kind: "assistant.append",
        id: "assistant-turn-1",
        delta: "A compact streamed update.",
        createdAt: session.updatedAt,
      }],
    }).sessionId).toBe(session.id)
    expect(workspaceDeltaSchema.safeParse({
      sessionId: session.id,
      updatedAt: session.updatedAt,
      operations: [{
        kind: "assistant.append",
        id: "assistant-turn-1",
        delta: "x".repeat(maximumWorkspaceDeltaChunkLength + 1),
        createdAt: session.updatedAt,
      }],
    }).success).toBe(false)
  })

  it("bounds skill documents returned by discovered ID", () => {
    expect(skillDocumentSchema.parse({
      skill: {
        id: "skill-4d6f4d6f4d6f",
        name: "repo-audit",
        description: "Audit a repository and render a ranked report.",
        path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
        scope: "user",
        source: "agents",
        ...skillSecurityMetadata,
      },
      content: "---\nname: repo-audit\n---\n",
    }).content).toContain("repo-audit")
    expect(skillDocumentSchema.safeParse({
      skill: {
        id: "skill-4d6f4d6f4d6f",
        name: "repo-audit",
        description: "Audit repositories.",
        path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
        scope: "user",
        source: "agents",
        ...skillSecurityMetadata,
      },
      content: "x".repeat(128 * 1_024 + 1),
    }).success).toBe(false)
  })

  it("validates skill provenance without claiming execution trust", () => {
    expect(skillSummarySchema.parse({
      id: "skill-4d6f4d6f4d6f",
      name: "repo-audit",
      description: "Audit a repository and render a ranked report.",
      path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
      scope: "user",
      source: "agents",
      ...skillSecurityMetadata,
    })).toMatchObject({
      name: "repo-audit",
      scope: "user",
      source: "agents",
      ...skillSecurityMetadata,
    })
    expect(skillSummarySchema.safeParse({
      id: "skill-4d6f4d6f4d6f",
      name: "Repo Audit",
      description: "Audit repositories.",
      path: "relative/SKILL.md",
      scope: "user",
      source: "agents",
    }).success).toBe(false)
  })

  it("validates scoped artifact access capabilities", () => {
    expect(artifactAuthorizeParamsSchema.parse({
      sessionId: "session-1",
      artifactId: "preview-1",
      revision: 3,
      purpose: "preview",
      bridgeChannel: "preview_channel_123456",
      client: "tablet",
    })).toEqual({
      sessionId: "session-1",
      artifactId: "preview-1",
      revision: 3,
      purpose: "preview",
      bridgeChannel: "preview_channel_123456",
      client: "tablet",
    })
    expect(artifactAuthorizeParamsSchema.safeParse({
      sessionId: "session-1",
      artifactId: "preview-1",
      revision: 3,
      purpose: "preview",
      bridgeChannel: "short",
      client: "tablet",
    }).success).toBe(false)
    expect(artifactAuthorizeResultSchema.parse({
      sessionId: "session-1",
      artifactId: "preview-1",
      revision: 3,
      purpose: "preview",
      bridgeChannel: "preview_channel_123456",
      expiresAt: 1_800_000_000,
      signature: "a".repeat(43),
    }).signature).toHaveLength(43)
    expect(artifactAuthorizeParamsSchema.safeParse({
      sessionId: "session-1", artifactId: "preview-1", revision: 3,
      purpose: "print", bridgeChannel: "preview_channel_123456", client: "web",
    }).success).toBe(false)
    for (const parentOrigin of ["https://app.domovoi.sh", "http://127.0.0.1:5178", "null"]) {
      expect(artifactAuthorizeParamsSchema.parse({
        sessionId: "session-1", artifactId: "preview-1", revision: 3,
        purpose: "preview", bridgeChannel: "preview_channel_123456", parentOrigin, client: "web",
      }).parentOrigin).toBe(parentOrigin)
      expect(artifactAuthorizeResultSchema.parse({
        sessionId: "session-1", artifactId: "preview-1", revision: 3,
        purpose: "preview", bridgeChannel: "preview_channel_123456", parentOrigin,
        expiresAt: 1_800_000_000, signature: "a".repeat(43),
      }).parentOrigin).toBe(parentOrigin)
    }
    for (const parentOrigin of ["https://app.domovoi.sh/path", "javascript:alert(1)", "file://", ""]) {
      expect(artifactAuthorizeParamsSchema.safeParse({
        sessionId: "session-1", artifactId: "preview-1", revision: 3,
        purpose: "preview", bridgeChannel: "preview_channel_123456", parentOrigin, client: "web",
      }).success).toBe(false)
    }
    expect(artifactAuthorizeParamsSchema.safeParse({
      sessionId: "session-1", artifactId: "preview-1", revision: 3,
      purpose: "preview", parentOrigin: "https://app.domovoi.sh", client: "web",
    }).success).toBe(false)
  })

  it("validates interactive terminal operations", () => {
    expect(terminalCreateParamsSchema.parse({
      terminalId: "terminal-1",
      sessionId: "session-billing",
      cols: 120,
      rows: 32,
      client: "desktop",
      clientId: "desktop-client-1",
    }).cols).toBe(120)
    expect(terminalSessionSchema.parse({
      terminalId: "terminal-1",
      sessionId: "session-billing",
      cols: 120,
      rows: 32,
      shell: "/bin/bash",
      cwd: "/worktrees/billing",
      buffer: "ready\r\n",
      owner: { client: "desktop", clientId: "desktop-client-1" },
    }).shell).toBe("/bin/bash")
    expect(terminalInputParamsSchema.parse({
      terminalId: "terminal-1",
      data: "pnpm test\r",
      client: "tablet",
      clientId: "tablet-client-1",
    }).data).toBe("pnpm test\r")
    expect(terminalResizeParamsSchema.parse({
      terminalId: "terminal-1",
      cols: 80,
      rows: 24,
      client: "web",
      clientId: "web-client-1",
    }).rows).toBe(24)
    expect(terminalCloseParamsSchema.parse({
      terminalId: "terminal-1",
      client: "phone",
      clientId: "phone-client-1",
    }).client).toBe("phone")
    expect(terminalClaimParamsSchema.parse({
      terminalId: "terminal-1",
      client: "phone",
      clientId: "phone-client-1",
    }).clientId).toBe("phone-client-1")
    expect(terminalOwnershipNotificationSchema.parse({
      terminalId: "terminal-1",
      owner: { client: "phone", clientId: "phone-client-1" },
    }).owner.client).toBe("phone")
    expect(terminalResizeParamsSchema.safeParse({
      terminalId: "terminal-1",
      cols: 0,
      rows: 24,
      client: "web",
      clientId: "web-client-1",
    }).success).toBe(false)
  })

  it("accepts the client identity the handshake accepts on terminal calls", () => {
    expect(terminalCreateParamsSchema.parse({
      terminalId: "terminal-1",
      sessionId: "session-billing",
      cols: 120,
      rows: 32,
      client: "cli",
      clientId: "abc",
    }).clientId).toBe("abc")
    expect(terminalOwnerSchema.parse({
      client: "cli",
      clientId: "  padded  ",
    }).clientId).toBe("padded")
    expect(terminalOwnerSchema.shape.clientId).toBe(clientIdentityIdSchema)
  })

  it("accepts an optional daemon credential during hello", () => {
    expect(helloParamsSchema.parse({
      client: "web",
      clientVersion: "0.0.1",
      protocolVersion: "0.1.0",
      authToken: "token-with-enough-entropy",
    }).authToken).toBe("token-with-enough-entropy")
    expect(helloParamsSchema.safeParse({
      client: "web",
      clientVersion: "0.0.1",
      protocolVersion: "0.1.0",
      authToken: "",
    }).success).toBe(false)
  })

  it("bounds the free text a client types into the daemon", () => {
    const runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      permissionMode: "ask" as const,
      auto: false,
    }
    expect(sessionSendParamsSchema.safeParse({
      sessionId: "session-billing",
      prompt: "x".repeat(262_144),
      client: "desktop",
    }).success).toBe(true)
    expect(sessionSendParamsSchema.safeParse({
      sessionId: "session-billing",
      prompt: "x".repeat(262_145),
      client: "desktop",
    }).success).toBe(false)
    const explicitSkills = {
      mode: "turn-explicit" as const,
      skills: [{
        skillId: "skill-111111111111",
        review: {
          contentDigest: `sha256:${"a".repeat(64)}`,
          manifest: { version: 1 as const, capabilities: ["filesystem.read" as const] },
        },
      }],
    }
    expect(sessionSendParamsSchema.parse({
      sessionId: "session-billing",
      prompt: "Run the audit",
      client: "desktop",
      skillSelection: explicitSkills,
    }).skillSelection).toEqual(explicitSkills)
    expect(sessionCreateParamsSchema.safeParse({
      title: "x".repeat(512),
      runtime,
      client: "desktop",
    }).success).toBe(true)
    expect(sessionCreateParamsSchema.safeParse({
      title: "x".repeat(513),
      runtime,
      client: "desktop",
    }).success).toBe(false)
    expect(projectOpenParamsSchema.safeParse({
      path: "x".repeat(4_096),
      client: "desktop",
    }).success).toBe(true)
    expect(projectOpenParamsSchema.safeParse({
      path: "x".repeat(4_097),
      client: "desktop",
    }).success).toBe(false)
    expect(checkpointCreateParamsSchema.safeParse({
      sessionId: "session-billing",
      label: "x".repeat(513),
      client: "desktop",
    }).success).toBe(false)
    expect(approvalResolveParamsSchema.safeParse({
      approvalId: "approval-1",
      decision: "deny",
      explanation: "x".repeat(4_097),
    }).success).toBe(false)
    expect(annotationCreateParamsSchema.safeParse({
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      anchor: { cssSelector: "main" },
      body: "x".repeat(8_193),
      client: "tablet",
    }).success).toBe(false)
    expect(annotationReplyParamsSchema.safeParse({
      annotationId: "annotation-1",
      body: "x".repeat(8_193),
      client: "tablet",
    }).success).toBe(false)
    expect(runtimeModelsParamsSchema.safeParse({
      provider: "x".repeat(65),
      client: "desktop",
    }).success).toBe(false)
    expect(runtimeSchema.safeParse({ ...runtime, provider: "x".repeat(65) }).success).toBe(false)
    expect(runtimeSchema.safeParse({ ...runtime, model: "x".repeat(257) }).success).toBe(false)
    expect(reasoningEffortSchema.safeParse("x".repeat(65)).success).toBe(false)
  })

  it("keeps the stored annotation anchor as strict as the preview bridge anchor", () => {
    expect(previewBridgeSelectionMessageSchema.shape.anchor).toBe(annotationAnchorSchema)
    expect(
      previewBridgeResolveAnchorsMessageSchema.shape.annotations.element.shape.anchor,
    ).toBe(annotationAnchorSchema)
    expect(annotationAnchorSchema.safeParse({
      cssSelector: "main",
      extra: true,
    }).success).toBe(false)
    expect(annotationAnchorSchema.safeParse({
      cssSelector: "x".repeat(1_001),
    }).success).toBe(false)
    expect(annotationAnchorSchema.safeParse({
      textQuote: "x".repeat(2_001),
    }).success).toBe(false)
    expect(annotationAnchorSchema.safeParse({
      bbox: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
    }).success).toBe(false)
    expect(annotationAnchorSchema.safeParse({
      bbox: { x: 0, y: 0, width: 10, height: 10, extra: true },
    }).success).toBe(false)
    expect(annotationAnchorSchema.safeParse({}).success).toBe(false)
    expect(annotationAnchorSchema.safeParse({
      cssSelector: "main > section:nth-child(2)",
      textQuote: "Apply the migration",
      bbox: { x: 40, y: 120, width: 280, height: 48 },
    }).success).toBe(true)
  })

  it("validates anchored annotation threads", () => {
    const annotation = {
      id: "annotation-1",
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      anchor: {
        cssSelector: "main > section:nth-child(2)",
        textQuote: "Apply the migration",
        bbox: { x: 40, y: 120, width: 280, height: 48 },
      },
      body: "Run this step on staging first.",
      status: "open",
      origin: "tablet",
      thread: [{
        id: "annotation-reply-1",
        body: "Agreed. I will revise the plan.",
        origin: "desktop",
        createdAt: "2026-08-25T22:00:00.000Z",
      }],
      createdAt: "2026-08-25T21:55:00.000Z",
      updatedAt: "2026-08-25T22:00:00.000Z",
    }

    expect(annotationSchema.parse(annotation)).toEqual(annotation)
    expect(annotationSchema.safeParse({
      ...annotation,
      anchor: {},
    }).success).toBe(false)
    expect(annotationVisualContextSchema.parse({
      status: "available",
      ref: `crop-${"a".repeat(64)}`,
      artifactRevision: 3,
      mimeType: "image/png",
      width: 640,
      height: 320,
      byteLength: 1024,
    }).status).toBe("available")
    expect(annotationVisualContextSchema.safeParse({
      status: "available",
      ref: "../../secret",
      artifactRevision: 3,
      mimeType: "image/png",
      width: 9000,
      height: 320,
      byteLength: 1024,
    }).success).toBe(false)
  })

  it("validates annotation mutation requests", () => {
    expect(annotationCreateParamsSchema.parse({
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      variantId: "variant-b",
      anchor: { textQuote: "Replay operations" },
      body: "Keep the progress visible.",
      visualContextUpload: {
        artifactRevision: 2,
        mimeType: "image/png",
        width: 320,
        height: 48,
        data: "iVBORw0KGgo=",
      },
      client: "tablet",
    }).visualContextUpload?.artifactRevision).toBe(2)
    for (const data of ["AAA", "A===", "AB==", "AAB=", "AAAA====", "iVBORw0K Ggo=", "iVBORw0KGgo=\n"]) {
      expect(annotationCreateParamsSchema.safeParse({
        sessionId: "session-billing",
        artifactId: "artifact-preview",
        anchor: { textQuote: "Replay operations" },
        body: "Invalid crop.",
        visualContextUpload: {
          artifactRevision: 2,
          mimeType: "image/png",
          width: 1,
          height: 1,
          data,
        },
        client: "desktop",
      }).success, data).toBe(false)
    }
    expect(annotationReplyParamsSchema.parse({
      annotationId: "annotation-1",
      body: "Updated in revision four.",
      client: "desktop",
    }).body).toBe("Updated in revision four.")
    expect(annotationSetStatusParamsSchema.parse({
      annotationId: "annotation-1",
      status: "resolved",
      client: "phone",
    }).status).toBe("resolved")
  })

  it("validates preview bridge messages", () => {
    const channel = "preview_channel_123456"
    expect(previewBridgePickerMessageSchema.parse({
      type: "domovoi.preview.picker",
      channel,
      active: true,
    }).active).toBe(true)
    expect(previewBridgeSelectionMessageSchema.parse({
      type: "domovoi.preview.selection",
      channel,
      artifactId: "artifact-preview",
      anchor: {
        cssSelector: "main > section:nth-of-type(2)",
        textQuote: "Review this migration step",
        bbox: { x: 24, y: 96, width: 320, height: 48 },
      },
      label: "section · Review this migration step",
    }).artifactId).toBe("artifact-preview")
    expect(previewBridgePickerMessageSchema.safeParse({
      type: "domovoi.preview.picker",
      channel: "short",
      active: true,
    }).success).toBe(false)

    expect(previewBridgeResolveAnchorsMessageSchema.parse({
      type: "domovoi.preview.resolve-anchors",
      channel,
      artifactId: "artifact-preview",
      requestId: "request_channel_123456",
      annotations: [{
        annotationId: "annotation-1",
        anchor: {
          cssSelector: "main > section:nth-of-type(2)",
          textQuote: "Review this migration step",
          bbox: { x: 24, y: 96, width: 320, height: 48 },
        },
      }],
    }).annotations).toHaveLength(1)
    expect(previewBridgeAnchorResolutionsMessageSchema.parse({
      type: "domovoi.preview.anchor-resolutions",
      channel,
      artifactId: "artifact-preview",
      requestId: "request_channel_123456",
      resolutions: [
        { annotationId: "annotation-1", status: "resolved", strategy: "text-quote" },
        { annotationId: "annotation-2", status: "unresolved" },
      ],
    }).resolutions[1]).toEqual({ annotationId: "annotation-2", status: "unresolved" })
    expect(previewBridgeResolveAnchorsMessageSchema.safeParse({
      type: "domovoi.preview.resolve-anchors",
      channel,
      artifactId: "artifact-preview",
      requestId: "request_channel_123456",
      annotations: Array.from({ length: 101 }, (_, index) => ({
        annotationId: `annotation-${index}`,
        anchor: { textQuote: "Bounded" },
      })),
    }).success).toBe(false)
    expect(previewBridgeResolveAnchorsMessageSchema.safeParse({
      type: "domovoi.preview.resolve-anchors",
      channel,
      artifactId: "artifact-preview",
      requestId: "request_channel_123456",
      annotations: [{
        annotationId: "annotation-1",
        anchor: { cssSelector: `#${"x".repeat(1_001)}` },
      }],
    }).success).toBe(false)
    expect(previewBridgeResolveAnchorsMessageSchema.safeParse({
      type: "domovoi.preview.resolve-anchors",
      channel,
      artifactId: "artifact-preview",
      requestId: "request_channel_123456",
      annotations: [{ annotationId: "annotation-1", anchor: { textQuote: "Bounded" } }],
      unexpected: true,
    }).success).toBe(false)
  })

  it("validates discovered provider models", () => {
    expect(runtimeModelsParamsSchema.parse({
      provider: "codex",
      client: "desktop",
    }).provider).toBe("codex")
    expect(runtimeModelsParamsSchema.parse({
      provider: "claude-code",
      client: "web",
    }).provider).toBe("claude-code")
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
    expect(providerModelSchema.safeParse({
      provider: "codex",
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Coding model",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
      isDefault: false,
    }).success).toBe(true)
  })

  it("validates machine provider readiness", () => {
    expect(providerRuntimeSchema.parse({
      id: "claude-code",
      command: "claude",
      status: "ready",
      version: "2.1.247",
      sessionCapable: false,
    })).toMatchObject({ status: "ready", sessionCapable: false })
    expect(providerRuntimeSchema.parse({
      id: "codex",
      command: "codex",
      status: "ready",
    }).sessionCapable).toBe(false)
    expect(providerRuntimeSchema.safeParse({
      id: "codex",
      command: "codex",
      status: "logged-in-ish",
    }).success).toBe(false)
  })

  it("upgrades snapshots that predate annotation state", () => {
    const legacy = structuredClone(demoWorkspace) as unknown as Record<string, unknown>
    delete legacy.annotations
    delete (legacy.machine as Record<string, unknown>).providers

    const upgraded = workspaceSnapshotSchema.parse(legacy)
    expect(upgraded.annotations).toEqual([])
    expect(upgraded.machine.providers).toEqual([])
  })

  it("rejects annotations detached from their session artifact", () => {
    const detached = structuredClone(demoWorkspace)
    detached.annotations[0]!.artifactId = "artifact-missing"
    expect(workspaceSnapshotSchema.safeParse(detached).success).toBe(false)

    const crossed = structuredClone(demoWorkspace)
    crossed.artifacts.push({
      id: "artifact-onboarding",
      sessionId: "session-onboarding",
      title: "Onboarding preview",
      type: "preview",
      revision: 1,
    })
    crossed.annotations[0]!.artifactId = "artifact-onboarding"
    expect(workspaceSnapshotSchema.safeParse(crossed).success).toBe(false)
  })

  it.each([
    ["project machine", "project.machineId", (snapshot: typeof demoWorkspace) => {
      snapshot.project!.machineId = "machine-missing"
    }],
    ["session project", "sessions.0.projectId", (snapshot: typeof demoWorkspace) => {
      snapshot.sessions[0]!.projectId = "project-missing"
    }],
    ["active session", "activeSessionId", (snapshot: typeof demoWorkspace) => {
      snapshot.activeSessionId = "session-missing"
    }],
    ["approval session", "approvals.0.sessionId", (snapshot: typeof demoWorkspace) => {
      snapshot.approvals[0]!.sessionId = "session-missing"
    }],
    ["approval rule project", "approvalRules.0.projectId", (snapshot: typeof demoWorkspace) => {
      snapshot.approvalRules.push({
        id: "rule-build",
        projectId: "project-missing",
        operation: "command",
        command: "pnpm test",
        createdBy: "desktop",
        createdAt: "2026-08-25T21:52:00.000Z",
        status: "inactive",
        inactiveReason: "legacy-text-only",
        inactivatedAt: "2026-09-03T18:30:00.000Z",
      })
    }],
    ["thread session", "thread.0.sessionId", (snapshot: typeof demoWorkspace) => {
      snapshot.thread[0]!.sessionId = "session-missing"
    }],
    ["artifact session", "artifacts.2.sessionId", (snapshot: typeof demoWorkspace) => {
      snapshot.artifacts.push({
        id: "artifact-orphan",
        sessionId: "session-missing",
        title: "Orphaned preview",
        type: "preview",
        revision: 1,
      })
    }],
    ["annotation session", "annotations.0.sessionId", (snapshot: typeof demoWorkspace) => {
      snapshot.artifacts[0]!.sessionId = "session-missing"
      snapshot.annotations[0]!.sessionId = "session-missing"
    }],
  ] as const)("rejects a missing %s aggregate reference", (_label, expectedPath, mutate) => {
    const snapshot = structuredClone(demoWorkspace)
    mutate(snapshot)

    const result = workspaceSnapshotSchema.safeParse(snapshot)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(expectedPath)
    }
  })

  it.each([
    ["session", "sessions.3.id", (snapshot: typeof demoWorkspace) => {
      snapshot.sessions.push(structuredClone(snapshot.sessions[0]!))
    }],
    ["approval", "approvals.1.id", (snapshot: typeof demoWorkspace) => {
      snapshot.approvals.push(structuredClone(snapshot.approvals[0]!))
    }],
    ["approval rule", "approvalRules.1.id", (snapshot: typeof demoWorkspace) => {
      const rule = {
        id: "rule-build",
        projectId: snapshot.project!.id,
        operation: "command",
        command: "pnpm test",
        createdBy: "desktop" as const,
        createdAt: "2026-08-25T21:52:00.000Z",
        status: "inactive" as const,
        inactiveReason: "legacy-text-only" as const,
        inactivatedAt: "2026-09-03T18:30:00.000Z",
      }
      snapshot.approvalRules.push(rule, structuredClone(rule))
    }],
    ["thread item", "thread.4.id", (snapshot: typeof demoWorkspace) => {
      snapshot.thread.push(structuredClone(snapshot.thread[0]!))
    }],
    ["artifact", "artifacts.2.id", (snapshot: typeof demoWorkspace) => {
      snapshot.artifacts.push(structuredClone(snapshot.artifacts[0]!))
    }],
    ["annotation", "annotations.2.id", (snapshot: typeof demoWorkspace) => {
      snapshot.annotations.push(structuredClone(snapshot.annotations[0]!))
    }],
    ["annotation reply", "annotations.0.thread.1.id", (snapshot: typeof demoWorkspace) => {
      const reply = snapshot.annotations[0]!.thread[0]!
      snapshot.annotations[0]!.thread.push(structuredClone(reply))
    }],
  ] as const)("rejects a duplicate %s ID", (_label, expectedPath, mutate) => {
    const snapshot = structuredClone(demoWorkspace)
    mutate(snapshot)

    const result = workspaceSnapshotSchema.safeParse(snapshot)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(expectedPath)
    }
  })

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

  it("rejects auto outside Build mode", () => {
    const broken = structuredClone(demoWorkspace)
    broken.sessions[0]!.runtime.permissionMode = "plan"
    broken.sessions[0]!.runtime.auto = true

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

    expect(approvalResolveParamsSchema.parse({
      approvalId: "approval-migrate",
      decision: "allow-once",
      client: "desktop",
    })).not.toHaveProperty("client")
  })

  it("validates the local project and session lifecycle", () => {
    expect(systemPauseAllParamsSchema.parse({ client: "desktop" })).toEqual({
      client: "desktop",
    })
    expect(projectOpenParamsSchema.parse({ path: "/code/domovoi", client: "desktop" })).toEqual({
      path: "/code/domovoi",
      client: "desktop",
    })
    expect(sessionCreateParamsSchema.parse({
      title: "Add persistence",
      runtime: demoWorkspace.sessions[0]!.runtime,
      client: "desktop",
    }).title).toBe("Add persistence")
    expect(sessionForkParamsSchema.parse({
      sessionId: "session-1",
      checkpointId: "checkpoint-1",
      requestId: "fork-request-1",
      runtime: demoWorkspace.sessions[0]!.runtime,
      client: "desktop",
    })).toMatchObject({ checkpointId: "checkpoint-1", requestId: "fork-request-1" })
    expect(sessionActivateParamsSchema.parse({
      sessionId: "session-1",
      client: "desktop",
    }).sessionId).toBe("session-1")
    expect(sessionPauseParamsSchema.parse({
      sessionId: "session-1",
      client: "phone",
    }).client).toBe("phone")
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
    expect(checkpointRestoreParamsSchema.parse({
      sessionId: "session-1",
      checkpointId: "checkpoint-1",
      client: "desktop",
    }).checkpointId).toBe("checkpoint-1")
  })
})

describe("persisted thread compatibility", () => {
  it("still parses a tool item written before file-change was retired", () => {
    const item = {
      id: "item-legacy",
      sessionId: "session-1",
      kind: "tool" as const,
      tool: "file-change" as const,
      status: "completed" as const,
      title: "Edit src/index.ts",
      createdAt: new Date().toISOString(),
    }
    expect(threadItemSchema.parse(item)).toMatchObject({ tool: "file-change" })
  })
})
