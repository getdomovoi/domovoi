import { cleanup, render } from "@testing-library/react"
import { memo } from "react"
import { afterEach, expect, it, vi } from "vitest"

const quickViewRenders = vi.hoisted(() => ({ count: 0 }))

vi.mock("./markdown-quick-view", async () => {
  const actual = await vi.importActual<typeof import("./markdown-quick-view")>("./markdown-quick-view")
  return {
    ...actual,
    MarkdownQuickView: memo(function MarkdownQuickView({ source }: { source: string }) {
      quickViewRenders.count += 1
      return <div data-testid="markdown">{source}</div>
    }),
  }
})

import { demoWorkspace, type Artifact, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ArtifactDock } from "./artifact-dock"

const sessionId = demoWorkspace.activeSessionId!
const plan: Artifact = {
  id: "artifact-plan-a",
  sessionId,
  title: "Replay the webhook",
  type: "plan",
  revision: 1,
  mimeType: "text/markdown",
  path: ".domovoi/plans/a.md",
  content: "# Replay the webhook\n\nStep one.",
}
const snapshot: WorkspaceSnapshot = {
  ...demoWorkspace,
  artifacts: [plan],
  annotations: [],
  workingPlans: [],
}

function dock() {
  return (
    <ArtifactDock
      snapshot={snapshot}
      onCollapse={vi.fn()}
      defaultTab="preview"
      tab="plan"
      rpcUrl="ws://127.0.0.1:47831/rpc"
      authorizeArtifact={() => new Promise(() => {})}
      connected
      terminalControls={{ claim: vi.fn(), release: vi.fn(), write: vi.fn(), resize: vi.fn() } as never}
      onReplyToAnnotation={vi.fn()}
      onSetAnnotationStatus={vi.fn()}
      onCreateAnnotation={vi.fn()}
      onLoadSessionHistory={vi.fn()}
      onLoadSessionEvidence={vi.fn()}
      onRevertSessionFile={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
  quickViewRenders.count = 0
})

it("does not render the plan quick view again when the plan did not change", () => {
  const { rerender } = render(dock())
  const onFirstRender = quickViewRenders.count
  expect(onFirstRender).toBeGreaterThan(0)

  rerender(dock())
  rerender(dock())

  expect(quickViewRenders.count).toBe(onFirstRender)
})
