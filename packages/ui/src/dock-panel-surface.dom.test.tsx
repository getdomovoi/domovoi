import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ArtifactDock } from "./artifact-dock"

const snapshot: WorkspaceSnapshot = { ...demoWorkspace, annotations: [], workingPlans: [] }

afterEach(cleanup)

// The lit tab is var(--accent) over whatever the panel is. The design puts the
// panel on var(--background), which is two steps below accent, so the lit tab
// reads as lit. On var(--sidebar) that step is a third smaller and the only cue
// saying which tab you are on nearly disappears.
describe("artifact dock panel surface", () => {
  it("sits on the background the accent was chosen against", () => {
    const { getByLabelText } = render(
      <ArtifactDock
        snapshot={snapshot}
        onCollapse={vi.fn()}
        defaultTab="changes"
        rpcUrl="ws://127.0.0.1:47831/rpc"
        authorizeArtifact={() => new Promise(() => {})}
        connected
        terminalControls={{ claim: vi.fn(), release: vi.fn(), write: vi.fn(), resize: vi.fn() } as never}
        onReplyToAnnotation={vi.fn()}
        onSetAnnotationStatus={vi.fn()}
        onCreateAnnotation={vi.fn()}
        onLoadSessionHistory={() => new Promise(() => {})}
        onLoadSessionEvidence={() => new Promise(() => {})}
        onRevertSessionFile={vi.fn()}
      />,
    )
    const panel = getByLabelText("Session artifacts")
    expect(panel.className).toContain("bg-background")
    expect(panel.className).not.toContain("bg-sidebar")
  })
})
