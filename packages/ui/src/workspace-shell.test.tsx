import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { ProviderRuntime, Runtime, ThreadItem } from "@getdomovoi/protocol"

import { demoWorkspace } from "@getdomovoi/protocol"

import { activeThreadKey, AppBar, checkpointBlockedReason, CheckpointThreadItem, ProviderReadinessList, RuntimeControls, Thread } from "./workspace-shell"

const runtime: Runtime = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}

const providers: ProviderRuntime[] = [
  {
    id: "codex",
    command: "codex",
    status: "ready",
    sessionCapable: true,
  },
]

describe("RuntimeControls", () => {
  it("locks every runtime input while an update is pending", () => {
    const markup = renderToStaticMarkup(
      <RuntimeControls
        runtime={runtime}
        providers={providers}
        pending
        onChange={vi.fn()}
        onListModels={vi.fn(async () => [])}
      />,
    )

    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6)
  })
})

describe("AppBar", () => {
  it("disables pause-all without an active turn", () => {
    const snapshot = structuredClone(demoWorkspace)
    for (const session of snapshot.sessions) delete session.activeTurnId
    const markup = renderToStaticMarkup(
      <AppBar
        snapshot={snapshot}
        connected
        onOpenProject={vi.fn()}
        onPauseAll={vi.fn()}
      />,
    )

    expect(markup).toMatch(/<button(?=[^>]*aria-label="Pause all")(?=[^>]*disabled="")/)
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
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
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
