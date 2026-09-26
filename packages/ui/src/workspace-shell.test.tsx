import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { ProviderRuntime, Runtime, SystemEmergencyStopResult, ThreadItem } from "@getdomovoi/protocol"

import { demoWorkspace, maximumEffectiveClientThreadItems, providerFailureSchema } from "@getdomovoi/protocol"

import { activeThreadKey, AnnotationComments, AppBar, archiveSessionDescription, ArtifactDock, artifactAuthorizationKey, capturePreviewThumbnailState, checkpointBlockedReason, checkpointRestoreBlocked, CheckpointRestoreAction, CheckpointThreadItem, forkProviderChoice, forkSessionBlockedReason, HistoryPanel, openProviderChoice, providerHandoffChoices, PreviewVariantThumbnail, ProviderReadinessList, renderedThreadForActiveSession, sessionIsArchiveReadOnly, skillInventoryRefreshKey, skillProjectRefreshKey, Thread } from "./workspace-shell"
import { buildWorkspaceCommands } from "./command-palette"
import { PreviewThumbnailLifecycle } from "./preview-thumbnails"

const runtime: Runtime = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}


describe("PreviewVariantThumbnail", () => {
  it("keeps authorization dependencies stable across unrelated artifact replacement", () => {
    const preview = demoWorkspace.artifacts.find((artifact) => artifact.type === "preview")!
    const replacement = { ...preview, title: `${preview.title} updated` }

    expect(artifactAuthorizationKey([replacement])).toBe(artifactAuthorizationKey([preview]))
    expect(artifactAuthorizationKey([{ ...replacement, revision: replacement.revision + 1 }]))
      .not.toBe(artifactAuthorizationKey([preview]))
  })

  it("renders real cached imagery when available and a truthful fallback otherwise", () => {
    expect(renderToStaticMarkup(<PreviewVariantThumbnail url="blob:domovoi-thumbnail" />)).toContain("<img")
    // The fallback is a tile, not a label. It carries no word, because an
    // aria-hidden one at 8px was readable by nobody.
    expect(renderToStaticMarkup(<PreviewVariantThumbnail />)).toContain('aria-hidden="true"')
    expect(renderToStaticMarkup(<PreviewVariantThumbnail />)).not.toContain("<img")
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



it("does not refetch skills for unrelated workspace updates", () => {
  const updated = structuredClone(demoWorkspace)
  updated.thread.push({
    id: "unrelated-thread-update",
    sessionId: updated.activeSessionId!,
    kind: "system",
    body: "Unrelated workspace update",
    createdAt: "2026-08-30T12:00:00.000Z",
  })

  expect(skillInventoryRefreshKey(updated)).toBe(skillInventoryRefreshKey(demoWorkspace))
  updated.machine.version = "0.0.2"
  expect(skillInventoryRefreshKey(updated)).not.toBe(skillInventoryRefreshKey(demoWorkspace))
})

it("keys the project half of a skill refresh to the facts the catalog follows", () => {
  const updated = structuredClone(demoWorkspace)
  updated.thread.push({
    id: "unrelated-thread-update",
    sessionId: updated.activeSessionId!,
    kind: "system",
    body: "Unrelated workspace update",
    createdAt: "2026-08-30T12:00:00.000Z",
  })
  updated.activeSessionId = updated.sessions[1]!.id
  expect(skillProjectRefreshKey(updated)).toBe(skillProjectRefreshKey(demoWorkspace))

  const renamed = structuredClone(demoWorkspace)
  renamed.project!.name = "acme-api-renamed"
  expect(skillProjectRefreshKey(renamed)).toBe(skillProjectRefreshKey(demoWorkspace))

  const moved = structuredClone(demoWorkspace)
  moved.project!.path = "/Users/dev/src/acme-api-copy"
  expect(skillProjectRefreshKey(moved)).not.toBe(skillProjectRefreshKey(demoWorkspace))

  const switched = structuredClone(demoWorkspace)
  switched.project!.branch = "feature/skills"
  expect(skillProjectRefreshKey(switched)).not.toBe(skillProjectRefreshKey(demoWorkspace))

  const closed = structuredClone(demoWorkspace)
  closed.project = null
  expect(skillProjectRefreshKey(closed)).toBe(skillProjectRefreshKey(null))
})

describe("Thread", () => {
  it("displays an approval receipt's server-issued connection identifier", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.thread.push({
      id: "receipt-client-identity",
      sessionId: snapshot.activeSessionId!,
      kind: "receipt",
      decision: "allow-once",
      operation: "Run tests",
      checkpoint: "checkpoint-one",
      client: "web",
      connectionId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-08-31T12:00:00.000Z",
    })

    const markup = renderToStaticMarkup(<Thread onQueuedChange={vi.fn()} snapshot={snapshot} connected onResolve={vi.fn(async () => {})} onSetRuntime={vi.fn(async () => {})} onForkSession={vi.fn(async () => {})} onListModels={vi.fn(async () => [])} onNewSession={vi.fn()} onSend={vi.fn(async () => {})} onCheckpoint={vi.fn(async () => {})} onRestoreCheckpoint={vi.fn(async () => {})} onPauseSession={vi.fn(async () => {})} />)

    expect(markup).toContain("decided from web, connection 11111111-1111-4111-8111-111111111111")
  })

  it("bounds initial rendered thread work with the canonical effective limit", () => {
    const snapshot = structuredClone(demoWorkspace)
    const sessionId = snapshot.activeSessionId!
    snapshot.thread = Array.from({ length: maximumEffectiveClientThreadItems + 5 }, (_, index) => ({
      id: `rendered-${index}`,
      sessionId,
      kind: "user" as const,
      body: `Message ${index}`,
      createdAt: snapshot.sessions[0]!.updatedAt,
    }))

    const rendered = renderedThreadForActiveSession(snapshot)

    expect(rendered).toHaveLength(maximumEffectiveClientThreadItems)
    expect(rendered[0]?.id).toBe("rendered-5")
  })

  it("draws mode in the composer's action row, with Think nowhere", () => {
    const snapshot = structuredClone(demoWorkspace)
    const markup = renderToStaticMarkup(<Thread onQueuedChange={vi.fn()} snapshot={snapshot} connected onResolve={vi.fn(async () => {})} onSetRuntime={vi.fn(async () => {})} onForkSession={vi.fn(async () => {})} onListModels={vi.fn(async () => [])} onNewSession={vi.fn()} onSend={vi.fn(async () => {})} onCheckpoint={vi.fn(async () => {})} onRestoreCheckpoint={vi.fn(async () => {})} onPauseSession={vi.fn(async () => {})} />)
    const actions = markup.slice(markup.indexOf("data-workspace-composer-actions"))
    expect(actions).toMatch(/aria-label="Mode: (Plan|Ask|Build)/)
    expect(markup).not.toContain("Think: ")
    const header = markup.slice(0, markup.indexOf("data-workspace-composer-actions"))
    expect(header).not.toMatch(/aria-label="Mode: /)
    expect(header).not.toContain("Think: ")
    expect(header).not.toContain("Auto, no gate")
  })

  it("renders safe Markdown in user, assistant, and system thread bodies", () => {
    const snapshot = structuredClone(demoWorkspace)
    const sessionId = snapshot.activeSessionId!
    snapshot.thread.push(
      { id: "user-md", sessionId, kind: "user", body: "**User note**", createdAt: "2026-08-30T10:00:00.000Z" },
      { id: "assistant-md", sessionId, kind: "assistant", body: "## Agent plan\n\n`pnpm test`", createdAt: "2026-08-30T10:01:00.000Z" },
      { id: "system-md", sessionId, kind: "system", body: "**System note** <script>alert(1)</script>", createdAt: "2026-08-30T10:02:00.000Z" },
    )
    const markup = renderToStaticMarkup(<Thread onQueuedChange={vi.fn()} snapshot={snapshot} connected onResolve={vi.fn(async () => {})} onSetRuntime={vi.fn(async () => {})} onForkSession={vi.fn(async () => {})} onListModels={vi.fn(async () => [])} onNewSession={vi.fn()} onSend={vi.fn(async () => {})} onCheckpoint={vi.fn(async () => {})} onRestoreCheckpoint={vi.fn(async () => {})} onPauseSession={vi.fn(async () => {})} />)
    expect(markup).toContain("<strong>User note</strong>")
    expect(markup).toContain("<h2")
    expect(markup).toContain("font-machine")
    expect(markup).not.toContain("<script")
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
  // v2 has one usage surface, the chip in the composer. The app bar carries
  // no token or cost readout of its own.
  it("carries no usage readout", () => {
    const markup = renderToStaticMarkup(
      <AppBar
        snapshot={structuredClone(demoWorkspace)}
        connected
        emergencyStopPending={false}
        emergencyStopOutcome={null}
        emergencyStopError={null}
        onOpenProject={vi.fn()}
        onPauseAll={vi.fn()}
        onEmergencyStop={vi.fn()}
      />,
    )
    expect(markup).not.toContain("Usage today")
    expect(markup).not.toMatch(/\d(\.\d)?k tokens/)
    expect(markup).not.toContain("cost unavailable")
  })

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
        onEmergencyStop={vi.fn()}
      />,
    )

    expect(markup).toMatch(/<button(?=[^>]*aria-label="Stop everything")(?![^>]*disabled="")/)
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
        onEmergencyStop={vi.fn()}
      />,
    )

    expect(markup).toMatch(/<button(?=[^>]*aria-label="Stop everything")(?=[^>]*disabled="")/)
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
        onEmergencyStop={vi.fn()}
      />,
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain("Emergency stop failed: daemon did not respond")
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
    expect(markup).toContain("Not found")
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
  it("exposes search, Everything and every semantic category", () => {
    const markup = renderToStaticMarkup(
      <HistoryPanel sessionId="session-billing" connected={false} onLoad={vi.fn()} />,
    )

    expect(markup).toContain('aria-label="Search session history"')
    for (const label of [
      "Everything",
      "Turns",
      "Approvals",
      "Checkpoints",
      "Transfers",
      "Handoffs",
      "Tools",
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
  // v2 carries no fixed session banner, so the worktree action lives in the
  // command palette. The editor it names is still the one the operator chose.
  it("names the worktree action for the selected editor", () => {
    const commands = buildWorkspaceCommands({
      activeWorkspacePath: "/worktrees/session-billing",
      openInEditor: vi.fn(),
      externalEditor: "cursor",
      connected: true,
      emergencyStopPending: false,
      hasProject: true,
      openProject: vi.fn(),
      newSession: vi.fn(),
      pauseAll: vi.fn(),
      emergencyStop: vi.fn(),
      reconnect: vi.fn(),
      setSurface: vi.fn(),
    })

    expect(commands.find((command) => command.id === "open-in-editor")?.label).toBe("Open in Cursor")
  })

  it("describes archive in the design's one line", () => {
    // I69, 2026-09-23: the description is the design's one line; what is
    // removed and kept is listed by the dialog body, not restated here.
    expect(archiveSessionDescription).toBe("Domovoi takes a final checkpoint, stops the agent and its terminals, then removes the worktree directory. Nothing is merged.")
  })

  it("renders archived sessions read-only with history still visible", () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    active.state = "archived"
    active.archiveRequestedAt = "2026-08-29T11:59:00.000Z"
    active.archiveCheckpoint = "a".repeat(40)
    active.archivedAt = "2026-08-29T12:00:00.000Z"
    active.branch = "domovoi/session-billing"
    active.unmergedFiles = 7
    delete active.workspacePath
    delete active.providerThreadId
    delete active.activeTurnId
    const markup = renderToStaticMarkup(
      <Thread
        onQueuedChange={vi.fn()}
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
      />,
    )

    expect(markup).toContain("Archived")
    expect(markup).toContain("The Stripe retries are double-charging")
    expect(markup).toContain("Archived, so the daemon accepts reads only.")
    // I69: the notice at the head of the thread says what archive did, names
    // the checkpoint kept, and draws the one way forward disabled and later.
    expect(markup).toContain("Archived and read-only. The worktree was removed. Branch <span class=\"font-machine\">domovoi/session-billing</span> and its final checkpoint are kept.")
    expect(markup).toMatch(/archived \d\d:\d\d · aaaaaaa · 7 files never merged/)
    expect(markup).toMatch(/Start a new session from this branch[\s\S]{0,200}later/)
    expect(markup).not.toContain("Unarchive")
    expect(markup).toMatch(/aria-label="Message"[^>]*disabled=""/)
    expect(markup).toContain("data-workspace-composer-actions")
  })

  it("draws no manual checkpoint control, even while a turn owns the worktree", () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    active.activeTurnId = "turn-active"
    const markup = renderToStaticMarkup(
      <Thread
        onQueuedChange={vi.fn()}
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
      />,
    )

    expect(markup).not.toMatch(/>Checkpoint<\/button>/)
    expect(markup).not.toContain("Stop the active turn before creating a checkpoint")
  })
})

describe("provider failure state", () => {
  it("uses the shared failed-read surface without allowing another send", () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    active.state = "failed"
    delete active.providerThreadId
    active.providerFailure = providerFailureSchema.parse({
      kind: "transport",
      action: "retry",
      message: "Provider connection failed",
      retryable: true,
    })
    const markup = renderToStaticMarkup(
      <Thread
        onQueuedChange={vi.fn()}
        snapshot={snapshot}
        connected
        onResolve={vi.fn(async () => {})}
        onSetRuntime={vi.fn(async () => {})}
        onRestartProviderThread={vi.fn(async () => {})}
        onForkSession={vi.fn(async () => {})}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
      />,
    )

    expect(markup).toContain("Could not read this session")
    expect(markup).toContain("nothing was written, nothing was lost")
    expect(markup).toContain("Try again")
    expect(markup).toMatch(/aria-label="Send message"[^>]*disabled=""/)
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
        onRevertSessionFile={vi.fn()}
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
