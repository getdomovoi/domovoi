import { demoWorkspace, type Artifact, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { ArtifactDock } from "./artifact-dock"

afterEach(cleanup)

// Pinning the sheet says it stays. Answering the plan is not a reason to take
// it away: the reply lands in the thread beside it, which is why it was
// pinned. An overlay sheet covers that thread, so there it still steps aside.
const sessionId = demoWorkspace.activeSessionId!
const plan: Artifact = {
  id: "artifact-plan-prose",
  sessionId,
  title: "Working plan",
  type: "plan",
  revision: 2,
  mimeType: "text/markdown",
  path: ".domovoi/plans/prose.md",
  content: "## Finish plan\n\nStep one.",
}
const snapshot: WorkspaceSnapshot = {
  ...demoWorkspace,
  artifacts: [plan],
  annotations: [],
  workingPlans: [],
}

const answerPlan = async (pinned: boolean) => {
  const onCollapse = vi.fn()
  const onCarryOnPlan = vi.fn(async () => {})
  render(
    <ArtifactDock
      snapshot={snapshot}
      pinned={pinned}
      onCollapse={onCollapse}
      onCarryOnPlan={onCarryOnPlan}
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
    />,
  )
  await userEvent.setup().click(screen.getByRole("button", { name: "Looks right, carry on" }))
  return { onCollapse, onCarryOnPlan }
}

it("keeps a pinned sheet open when the plan is answered", async () => {
  const { onCollapse, onCarryOnPlan } = await answerPlan(true)

  expect(onCarryOnPlan).toHaveBeenCalledOnce()
  expect(onCollapse).not.toHaveBeenCalled()
})

it("still steps an overlay sheet out of the way", async () => {
  const { onCollapse, onCarryOnPlan } = await answerPlan(false)

  expect(onCarryOnPlan).toHaveBeenCalledOnce()
  expect(onCollapse).toHaveBeenCalledOnce()
})
