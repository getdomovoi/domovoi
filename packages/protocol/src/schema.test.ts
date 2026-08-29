import { describe, expect, it } from "vitest"

import {
  annotationSchema,
  annotationCreateParamsSchema,
  annotationReplyParamsSchema,
  annotationSetStatusParamsSchema,
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
  providerRuntimeSchema,
  helloParamsSchema,
  sessionHistoryPageSchema,
  sessionHistoryParamsSchema,
  maximumWorkspaceDeltaChunkLength,
  runtimeModelsParamsSchema,
  systemPauseAllParamsSchema,
  terminalCloseParamsSchema,
  terminalClaimParamsSchema,
  terminalCreateParamsSchema,
  terminalInputParamsSchema,
  terminalOwnershipNotificationSchema,
  terminalResizeParamsSchema,
  terminalSessionSchema,
  previewBridgePickerMessageSchema,
  previewBridgeSelectionMessageSchema,
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
} from "./index.js"

describe("workspace protocol", () => {
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
      limit: 101,
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
    })).toMatchObject({
      name: "repo-audit",
      scope: "user",
      source: "agents",
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
      artifactId: "preview-1",
      bridgeChannel: "preview_channel_123456",
      client: "tablet",
    })).toEqual({
      artifactId: "preview-1",
      bridgeChannel: "preview_channel_123456",
      client: "tablet",
    })
    expect(artifactAuthorizeParamsSchema.safeParse({
      artifactId: "preview-1",
      bridgeChannel: "short",
      client: "tablet",
    }).success).toBe(false)
    expect(artifactAuthorizeResultSchema.parse({
      artifactId: "preview-1",
      bridgeChannel: "preview_channel_123456",
      expiresAt: 1_800_000_000,
      signature: "a".repeat(43),
    }).signature).toHaveLength(43)
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

  it("accepts an optional daemon credential during hello", () => {
    expect(helloParamsSchema.parse({
      client: "web",
      clientVersion: "0.0.1",
      authToken: "token-with-enough-entropy",
    }).authToken).toBe("token-with-enough-entropy")
    expect(helloParamsSchema.safeParse({
      client: "web",
      clientVersion: "0.0.1",
      authToken: "",
    }).success).toBe(false)
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
  })

  it("validates annotation mutation requests", () => {
    expect(annotationCreateParamsSchema.parse({
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      variantId: "variant-b",
      anchor: { textQuote: "Replay operations" },
      body: "Keep the progress visible.",
      client: "tablet",
    }).client).toBe("tablet")
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
