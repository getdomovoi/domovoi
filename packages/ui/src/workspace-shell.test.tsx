import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { ProviderRuntime, Runtime, SystemEmergencyStopResult, ThreadItem } from "@getdomovoi/protocol"

import { demoWorkspace, providerFailureSchema } from "@getdomovoi/protocol"

import { activeThreadKey, AnnotationComments, AppBar, archiveSessionDescription, ArchiveSessionAction, ArtifactDock, capturePreviewThumbnailState, checkpointBlockedReason, checkpointRestoreBlocked, CheckpointRestoreAction, CheckpointThreadItem, forkProviderChoice, forkSessionBlockedReason, HistoryPanel, openProviderChoice, providerHandoffChoices, providerSettingsNavigationLabel, PreviewVariantThumbnail, ProviderReadinessList, RuntimeControls, sessionIsArchiveReadOnly, Thread } from "./workspace-shell"
import { PreviewThumbnailLifecycle } from "./preview-thumbnails"

const runtime: Runtime = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}

describe("PreviewVariantThumbnail", () => {
  it("renders real cached imagery when available and a truthful fallback otherwise", () => {
    expect(renderToStaticMarkup(<PreviewVariantThumbnail url="blob:domovoi-thumbnail" />)).toContain("<img")
    expect(renderToStaticMarkup(<PreviewVariantThumbnail />)).toContain("PREVIEW")
    expect(renderToStaticMarkup(<PreviewVariantThumbnail url="https://attacker.example/x.png" />)).not.toContain("<img")
  })

  it.each([
    ["invalid", async () => ({ mimeType: "image/png" as const, width: 0, height: 1, data: "invalid" })],
    ["failed", async () => { throw new Error("capture denied") }],
  ])("removes revoked thumbnail state after %s replacement capture", async (_case, capture) => {
    const revoke = vi.fn()
    const lifecycle = new PreviewThumbnailLifecycle(1, revoke)
    lifecycle.reserve("old-artifact", 1)
    lifecycle.resolve("old-artifact", 1, "blob:old")
    const states: ReadonlyMap<string, string>[] = []

    await capturePreviewThumbnailState({
      lifecycle,
      artifactId: "new-artifact",
      revision: 2,
      capture,
      sync: (ready) => states.push(new Map(ready)),
    })

    expect(revoke).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith("blob:old")
    expect(states.length).toBeGreaterThanOrEqual(1)
    expect(states.every((state) => !state.has("old-artifact:1"))).toBe(true)
    expect(states.at(-1)).toEqual(new Map())
  })
})

const providers: ProviderRuntime[] = [
  {
    id: "codex",
    command: "codex",
    status: "ready",
    sessionCapable: true,
  },
]

it("names settings navigation for the surface it opens", () => {
  expect(providerSettingsNavigationLabel).toBe("Provider settings")
})

describe("RuntimeControls", () => {
  it("renders safe Markdown in user, assistant, and system thread bodies", () => {
    const snapshot = structuredClone(demoWorkspace)
    const sessionId = snapshot.activeSessionId!
    snapshot.thread.push(
      { id: "user-md", sessionId, kind: "user", body: "**User note**", createdAt: "2026-08-30T10:00:00.000Z" },
      { id: "assistant-md", sessionId, kind: "assistant", body: "## Agent plan\n\n`pnpm test`", createdAt: "2026-08-30T10:01:00.000Z" },
      { id: "system-md", sessionId, kind: "system", body: "**System note** <script>alert(1)</script>", createdAt: "2026-08-30T10:02:00.000Z" },
    )
    const markup = renderToStaticMarkup(<Thread snapshot={snapshot} connected onResolve={vi.fn(async () => {})} onSetRuntime={vi.fn(async () => {})} onForkSession={vi.fn(async () => {})} onListModels={vi.fn(async () => [])} onNewSession={vi.fn()} onSend={vi.fn(async () => {})} onCheckpoint={vi.fn(async () => {})} onRestoreCheckpoint={vi.fn(async () => {})} onPauseSession={vi.fn(async () => {})} onArchiveSession={vi.fn(async () => {})} />)
    expect(markup).toContain("<strong>User note</strong>")
    expect(markup).toContain("<h2")
    expect(markup).toContain("font-machine")
    expect(markup).not.toContain("<script")
  })
  it("locks every runtime input while an update is pending", () => {
    const markup = renderToStaticMarkup(
      <RuntimeControls
        runtime={runtime}
        providers={providers}
        pending
        forkCheckpointId="thread-checkpoint"
        onChange={vi.fn()}
        onFork={vi.fn()}
        onListModels={vi.fn(async () => [])}
      />,
    )

    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6)
  })

  it("keeps switch-here distinct from a durable checkpoint fork", () => {
    expect(providerHandoffChoices(false, undefined)).toEqual([
      { label: "Switch here", variant: "outline", disabled: false },
      { label: "Fork session", variant: "default", disabled: false },
    ])
    expect(providerHandoffChoices(true, undefined).every((choice) => choice.disabled)).toBe(true)
    expect(providerHandoffChoices(false, "Create a checkpoint first")[1]).toMatchObject({
      label: "Fork session",
      disabled: true,
    })
  })

  it("reuses one fork request ID after failure for same-provider model choices", async () => {
    const sameProviderModel = {
      provider: runtime.provider,
      id: "gpt-5.6-sol-mini",
      displayName: "GPT-5.6 Sol Mini",
      description: "Smaller coding model",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      isDefault: false,
    }
    const createRequestId = vi.fn(() => "fork-request-stable")
    const choice = openProviderChoice(runtime, sameProviderModel, createRequestId)
    expect(choice).toMatchObject({ model: sameProviderModel, requestId: "fork-request-stable" })
    expect(createRequestId).toHaveBeenCalledOnce()

    const onFork = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined)
    await expect(forkProviderChoice(runtime, choice!, "thread-checkpoint", onFork)).rejects.toThrow("timeout")
    await expect(forkProviderChoice(runtime, choice!, "thread-checkpoint", onFork)).resolves.toBeUndefined()
    expect(onFork).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: sameProviderModel.id }),
      "thread-checkpoint",
      "fork-request-stable",
    )
    expect(onFork).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: sameProviderModel.id }),
      "thread-checkpoint",
      "fork-request-stable",
    )
  })

  it("explains unsafe fork boundaries", () => {
    const session = structuredClone(demoWorkspace.sessions[0]!)
    const checkpoint = demoWorkspace.thread.find((item) => item.kind === "checkpoint")
    session.workspacePath = "/worktrees/session-billing"
    session.state = "idle"
    delete session.activeTurnId
    expect(forkSessionBlockedReason(session, checkpoint)).toBeUndefined()
    expect(forkSessionBlockedReason({ ...session, state: "active" }, checkpoint)).toBe(
      "Stop the active turn before forking",
    )
    expect(forkSessionBlockedReason({ ...session, state: "waiting" }, checkpoint)).toBe(
      "Resolve the pending approval before forking",
    )
    expect(forkSessionBlockedReason(session, undefined)).toBe(
      "Create a durable checkpoint before forking",
    )
  })
})

describe("AppBar", () => {
  it("keeps pause-all available while connected without an active turn", () => {
    const snapshot = structuredClone(demoWorkspace)
    for (const session of snapshot.sessions) delete session.activeTurnId
    const markup = renderToStaticMarkup(
      <AppBar
        snapshot={snapshot}
        connected
        emergencyStopPending={false}
        emergencyStopOutcome={null}
        emergencyStopError={null}
        onOpenProject={vi.fn()}
        onPauseAll={vi.fn()}
      />,
    )

    expect(markup).toMatch(/<button(?=[^>]*aria-label="Pause all")(?![^>]*disabled="")/)
  })

  it("disables pause-all while pending and announces its outcome", () => {
    const outcome: SystemEmergencyStopResult = {
      snapshot: demoWorkspace,
      stopId: "stop-1",
      requestedAt: "2026-08-29T12:00:00.000Z",
      client: "desktop",
      outcomes: {
        turnsStopped: 2,
        terminalsClosed: 1,
        approvalsDenied: 3,
        mutationsCancelled: 4,
        providersReset: 2,
      },
      failures: [],
    }
    const markup = renderToStaticMarkup(
      <AppBar
        snapshot={demoWorkspace}
        connected
        emergencyStopPending
        emergencyStopOutcome={outcome}
        emergencyStopError={null}
        onOpenProject={vi.fn()}
        onPauseAll={vi.fn()}
      />,
    )

    expect(markup).toMatch(/<button(?=[^>]*aria-label="Pause all")(?=[^>]*disabled="")/)
    expect(markup).toContain('role="status"')
    expect(markup).toContain("2 turns stopped")
    expect(markup).toContain("1 terminal closed")
    expect(markup).toContain("3 approvals denied")
    expect(markup).toContain("4 mutations cancelled")
    expect(markup).toContain("2 providers reset")
  })

  it("announces an emergency-stop error", () => {
    const markup = renderToStaticMarkup(
      <AppBar
        snapshot={demoWorkspace}
        connected
        emergencyStopPending={false}
        emergencyStopOutcome={null}
        emergencyStopError="daemon did not respond"
        onOpenProject={vi.fn()}
        onPauseAll={vi.fn()}
      />,
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain("Pause all failed: daemon did not respond")
  })
})

describe("ProviderReadinessList", () => {
  it("shows machine readiness without enabling unsupported adapters", () => {
    const providers: ProviderRuntime[] = [
      {
        id: "claude-code",
        command: "claude",
        status: "ready",
        version: "2.1.247",
        sessionCapable: false,
      },
      {
        id: "codex",
        command: "codex",
        status: "ready",
        version: "0.149.0",
        sessionCapable: true,
      },
      {
        id: "grok",
        command: "grok",
        status: "missing",
        sessionCapable: false,
      },
    ]

    const markup = renderToStaticMarkup(<ProviderReadinessList providers={providers} />)

    expect(markup).toContain("Claude Code")
    expect(markup).toContain("adapter unavailable")
    expect(markup).toContain("Codex")
    expect(markup).toContain("Ready")
    expect(markup).toContain("Not installed")
    expect(markup).toContain("2.1.247")
  })
})

describe("activeThreadKey", () => {
  it("changes when the active session changes", () => {
    const first = structuredClone(demoWorkspace)
    const second = structuredClone(demoWorkspace)
    second.activeSessionId = "session-audit"

    expect(activeThreadKey(first)).not.toBe(activeThreadKey(second))
  })
})

describe("CheckpointThreadItem", () => {
  it("offers restore only for restorable checkpoints", () => {
    const item: Extract<ThreadItem, { kind: "checkpoint" }> = {
      id: "checkpoint-1",
      sessionId: "session-billing",
      kind: "checkpoint",
      label: "bbbbbbbb · after tests",
      commit: "b".repeat(40),
      createdAt: "2026-08-28T06:00:00.000Z",
    }
    const restorable = renderToStaticMarkup(
      <CheckpointThreadItem item={item} disabled={false} onRestore={vi.fn()} />,
    )
    const legacy = renderToStaticMarkup(
      <CheckpointThreadItem item={{ ...item, commit: undefined }} disabled={false} onRestore={vi.fn()} />,
    )

    expect(restorable).toContain("Restore worktree")
    expect(legacy).not.toContain("Restore worktree")
  })

  it("keeps an open confirmation inert when the session becomes archived", () => {
    const onRestore = vi.fn()
    const action = CheckpointRestoreAction({
      checkpointId: "checkpoint-1",
      disabled: true,
      onRestore,
    })

    expect(action.props.disabled).toBe(true)
    action.props.onClick()
    expect(onRestore).not.toHaveBeenCalled()
    expect(checkpointRestoreBlocked(false, true)).toBe(true)
    expect(checkpointRestoreBlocked(false, false)).toBe(false)
  })
})

describe("HistoryPanel", () => {
  it("exposes search and every semantic category", () => {
    const markup = renderToStaticMarkup(
      <HistoryPanel sessionId="session-billing" connected={false} onLoad={vi.fn()} />,
    )

    expect(markup).toContain('aria-label="Search session history"')
    for (const label of [
      "Messages",
      "Tools",
      "Approvals",
      "Handoffs",
      "Checkpoints",
      "Annotations",
      "Tests",
    ]) expect(markup).toContain(`>${label}</button>`)
  })
})

describe("checkpointBlockedReason", () => {
  it("explains why manual checkpoints are unavailable during an active turn", () => {
    expect(checkpointBlockedReason("turn-active")).toBe(
      "Stop the active turn before creating a checkpoint",
    )
    expect(checkpointBlockedReason(undefined)).toBeUndefined()
  })
})

describe("Thread", () => {
  it("offers a signed archive confirmation describing retained history and cleanup", () => {
    const markup = renderToStaticMarkup(
      <ArchiveSessionAction disabled={false} onArchive={vi.fn()} />,
    )

    expect(markup).toContain("Archive session")
    expect(archiveSessionDescription).toContain("final checkpoint")
    expect(archiveSessionDescription).toContain("provider and terminal")
    expect(archiveSessionDescription).toContain("source checkout's branch, HEAD, status, and files remain unchanged")
  })

  it("renders archived sessions read-only with history still visible", () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    active.state = "archived"
    active.archiveRequestedAt = "2026-08-29T11:59:00.000Z"
    active.archiveCheckpoint = "a".repeat(40)
    active.archivedAt = "2026-08-29T12:00:00.000Z"
    delete active.workspacePath
    delete active.providerThreadId
    delete active.activeTurnId
    const markup = renderToStaticMarkup(
      <Thread
        snapshot={snapshot}
        connected
        onResolve={vi.fn(async () => {})}
        onSetRuntime={vi.fn(async () => {})}
        onForkSession={vi.fn(async () => {})}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
        onArchiveSession={vi.fn(async () => {})}
      />,
    )

    expect(markup).toContain("Archived")
    expect(markup).toContain("The Stripe retries are double-charging")
    expect(markup).not.toContain('aria-label="Message"')
  })

  it("disables manual checkpoint creation while the active turn owns the worktree", () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    active.activeTurnId = "turn-active"
    const markup = renderToStaticMarkup(
      <Thread
        snapshot={snapshot}
        connected
        onResolve={vi.fn(async () => {})}
        onSetRuntime={vi.fn(async () => {})}
        onForkSession={vi.fn(async () => {})}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
        onArchiveSession={vi.fn(async () => {})}
      />,
    )

    expect(markup).toMatch(
      /<button(?=[^>]*disabled="")(?=[^>]*title="Stop the active turn before creating a checkpoint")[^>]*>Checkpoint<\/button>/,
    )
    expect(markup).toContain(
      '<span role="status" class="font-machine text-[9px] text-faint">Stop the active turn before creating a checkpoint</span>',
    )
  })
})

describe("provider failure guidance", () => {
  it.each([
    ["authentication-expired", "sign-in", "Provider authentication expired", false, "Open Provider settings and sign in again"],
    ["rate-limit", "retry", "Provider rate limit reached", true, "Retry the message after the provider cooldown"],
    ["quota-exhausted", "check-quota", "Provider quota is exhausted", false, "Check the provider quota or billing plan"],
    ["model-unavailable", "change-model", "Selected model is unavailable", false, "Choose another model in the runtime controls"],
    ["transport", "retry", "Provider connection failed", true, "Retry the message after the provider reconnects"],
    ["unknown", "retry", "Provider request failed", true, "Retry the message, or review Provider settings if the failure continues"],
  ] as const)("renders %s with a fixed recovery action", (kind, action, message, retryable, guidance) => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    active.state = "failed"
    active.providerFailure = providerFailureSchema.parse({ kind, action, message, retryable })
    const markup = renderToStaticMarkup(
      <Thread
        snapshot={snapshot}
        connected
        onResolve={vi.fn(async () => {})}
        onSetRuntime={vi.fn(async () => {})}
        onForkSession={vi.fn(async () => {})}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
        onArchiveSession={vi.fn(async () => {})}
      />,
    )

    expect(markup).toContain(message)
    expect(markup).toContain(guidance)
  })
})

describe("archived annotation controls", () => {
  it("surfaces preserved and unresolved anchor states", () => {
    const annotations = structuredClone(demoWorkspace.annotations.slice(0, 2))
    annotations[0]!.visualContext = {
      status: "available",
      ref: `crop-${"a".repeat(64)}`,
      artifactRevision: 3,
      mimeType: "image/png",
      width: 320,
      height: 120,
      byteLength: 1024,
    }
    const markup = renderToStaticMarkup(
      <AnnotationComments
        annotations={annotations}
        anchorResolutions={new Map([
          [annotations[0]!.id, "text-quote"],
          [annotations[1]!.id, "unresolved"],
        ])}
        readOnly={false}
        onReply={vi.fn(async () => {})}
        onSetStatus={vi.fn(async () => {})}
      />,
    )

    expect(markup).toContain("text anchor")
    expect(markup).toContain("anchor unavailable")
    expect(markup).toContain("visual context · 320×120 · revision 3")
  })

  it("keeps annotations visible while hiding every mutation control", () => {
    const archived = structuredClone(demoWorkspace.sessions[0]!)
    archived.state = "archived"
    archived.archiveRequestedAt = "2026-08-29T11:59:00.000Z"
    archived.archiveCheckpoint = "a".repeat(40)
    archived.archivedAt = "2026-08-29T12:00:00.000Z"
    delete archived.workspacePath
    delete archived.providerThreadId
    delete archived.activeTurnId
    const annotations = demoWorkspace.annotations.filter(
      (annotation) => annotation.sessionId === archived.id,
    )
    const markup = renderToStaticMarkup(
      <AnnotationComments
        annotations={annotations}
        readOnly={sessionIsArchiveReadOnly(archived)}
        onReply={vi.fn(async () => {})}
        onSetStatus={vi.fn(async () => {})}
      />,
    )

    expect(markup).toContain(annotations[0]!.body)
    expect(markup).not.toContain(">Reply</button>")
    expect(markup).not.toContain(">Resolve</button>")
    expect(sessionIsArchiveReadOnly({ ...archived, state: "archiving" })).toBe(true)
    expect(sessionIsArchiveReadOnly({ ...archived, state: "idle" })).toBe(false)

    const dockSnapshot = { ...structuredClone(demoWorkspace), activeSessionId: archived.id, sessions: [
      archived,
      ...demoWorkspace.sessions.slice(1),
    ] }
    dockSnapshot.artifacts.push(
      { id: "variant-a", sessionId: archived.id, title: "Variant A", type: "preview", revision: 4, path: "design-studio/x/variant-a.html", mimeType: "text/html", variant: { id: "a", groupId: "design-studio/x", label: "Variant A", order: 0 } },
      { id: "variant-b", sessionId: archived.id, title: "Variant B", type: "preview", revision: 3, path: "design-studio/x/variant-b.html", mimeType: "text/html", variant: { id: "b", groupId: "design-studio/x", label: "Variant B", order: 1 } },
    )
    const dock = renderToStaticMarkup(
      <ArtifactDock
        snapshot={dockSnapshot}
        onCollapse={vi.fn()}
        defaultTab="preview"
        rpcUrl="ws://127.0.0.1/rpc"
        authorizeArtifact={vi.fn()}
        connected={false}
        terminalControls={{
          clientId: "test",
          create: vi.fn(),
          claim: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          close: vi.fn(),
          subscribe: vi.fn(() => vi.fn()),
        }}
        onReplyToAnnotation={vi.fn()}
        onSetAnnotationStatus={vi.fn()}
        onCreateAnnotation={vi.fn()}
        onLoadSessionHistory={vi.fn()}
        onLoadSessionEvidence={vi.fn()}
      />,
    )
    expect(dock).not.toContain(">Annotate</button>")
    expect(dock).toContain("Variant A")
    expect(dock).toContain("Selected")
    expect(dock).toContain("390 pixel preview")
    expect(dock).toContain(">Compare</button>")
    expect(dock).toContain("Print view")
    expect(dock).toContain("Download safe copy")
    expect(dock).toContain("Safe copies remove scripts, forms, and external assets")
  })
})
