import { demoWorkspace, type SkillEnablementReview } from "@getdomovoi/protocol"
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

const manifest = { version: 1 as const, capabilities: ["filesystem.read" as const] }

function review(skillId: string, enabled = true): SkillEnablementReview {
  return {
    projectId: "project-one",
    skillId,
    enabled,
    contentDigest: `sha256:${"a".repeat(64)}`,
    manifest,
    reviewedAt: "2026-09-03T10:00:00.000Z",
    reviewedBy: { client: "desktop" },
  }
}

it("does not expose a persistent skill chooser in the composer", () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.skillEnablements = [review("skill-aaaaaaaaaaaa")].map((entry) => ({
    ...entry,
    projectId: snapshot.project!.id,
  }))

  render(
    <TooltipProvider>
      <Thread
      onQueuedChange={vi.fn()}
        snapshot={snapshot}
        connected
        onResolve={vi.fn()}
        onSetRuntime={vi.fn()}
        onRestartProviderThread={vi.fn()}
        onForkSession={vi.fn()}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn()}
        onRestoreCheckpoint={vi.fn()}
        onPauseSession={vi.fn()}
        skillNames={{ "skill-aaaaaaaaaaaa": "plan-preview" }}
      />
    </TooltipProvider>,
  )

  const actions = document.querySelector("[data-workspace-composer-actions]")
  expect(actions?.textContent).not.toContain("plan-preview")
  expect(actions?.textContent).not.toContain("+ skill")
})
