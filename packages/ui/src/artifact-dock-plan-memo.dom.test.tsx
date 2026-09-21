import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

const markdownCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock("react-markdown", () => ({
  default: (props: { children?: string }) => {
    markdownCalls.count += 1
    return <div data-testid="markdown">{props.children}</div>
  },
}))

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
  markdownCalls.count = 0
})

it("does not parse the plan markdown again when the plan did not change", () => {
  const { rerender } = render(dock())
  expect(markdownCalls.count).toBe(1)

  rerender(dock())
  rerender(dock())

  expect(markdownCalls.count).toBe(1)
})
