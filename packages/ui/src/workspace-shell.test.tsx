import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import { demoWorkspace } from "@getdomovoi/protocol"

import { activeThreadKey, AppBar, RuntimeControls } from "./workspace-shell"

const runtime: Runtime = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}

describe("RuntimeControls", () => {
  it("locks every runtime input while an update is pending", () => {
    const markup = renderToStaticMarkup(
      <RuntimeControls
        runtime={runtime}
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

describe("activeThreadKey", () => {
  it("changes when the active session changes", () => {
    const first = structuredClone(demoWorkspace)
    const second = structuredClone(demoWorkspace)
    second.activeSessionId = "session-audit"

    expect(activeThreadKey(first)).not.toBe(activeThreadKey(second))
  })
})
