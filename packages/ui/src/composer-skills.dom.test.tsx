import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { SkillEnablementReview, WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerSkillChip } from "./composer-skills.js"

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

function snapshot(reviews: SkillEnablementReview[]): Pick<WorkspaceSnapshot, "project" | "skillEnablements"> {
  return {
    project: { id: "project-one" } as WorkspaceSnapshot["project"],
    skillEnablements: reviews,
  }
}

it("names the single skill this turn will carry", () => {
  render(<TooltipProvider><ComposerSkillChip snapshot={snapshot([review("skill-aaaaaaaaaaaa")])} skillNames={{ "skill-aaaaaaaaaaaa": "plan-preview" }} onOpenSkills={vi.fn()} /></TooltipProvider>)

  expect(screen.getByRole("button", { name: /plan-preview/u }).textContent).toContain("plan-preview")
})

it("counts them instead of listing when several are enabled", () => {
  render(<TooltipProvider><ComposerSkillChip
    snapshot={snapshot([review("skill-aaaaaaaaaaaa"), review("skill-bbbbbbbbbbbb")])}
    skillNames={{ "skill-aaaaaaaaaaaa": "plan-preview", "skill-bbbbbbbbbbbb": "replay-audit" }}
    onOpenSkills={vi.fn()}
  /></TooltipProvider>)

  expect(screen.getByRole("button", { name: /2 skills/u })).toBeTruthy()
})

it("counts only what the project actually enabled", () => {
  render(<TooltipProvider><ComposerSkillChip
    snapshot={snapshot([review("skill-aaaaaaaaaaaa"), review("skill-bbbbbbbbbbbb", false)])}
    skillNames={{ "skill-aaaaaaaaaaaa": "plan-preview" }}
    onOpenSkills={vi.fn()}
  /></TooltipProvider>)

  expect(screen.getByRole("button", { name: /plan-preview/u })).toBeTruthy()
})

it("offers to add one when the project has none", async () => {
  const onOpenSkills = vi.fn()
  render(<TooltipProvider><ComposerSkillChip snapshot={snapshot([])} skillNames={{}} onOpenSkills={onOpenSkills} /></TooltipProvider>)

  expect(screen.queryByRole("button", { name: /skills?$/u })).toBeNull()
  await userEvent.click(screen.getByRole("button", { name: "Add a skill to this turn" }))
  expect(onOpenSkills).toHaveBeenCalledOnce()
})

it("says nothing at all without an open project", () => {
  render(<TooltipProvider><ComposerSkillChip
    snapshot={{ project: null, skillEnablements: [review("skill-aaaaaaaaaaaa")] } as never}
    skillNames={{}}
    onOpenSkills={vi.fn()}
  /></TooltipProvider>)

  expect(screen.queryByRole("button", { name: "Add a skill to this turn" })).toBeNull()
})

it("appears in the composer, not only as a component", () => {
  const shell = readFileSync(join(import.meta.dirname, "workspace-shell.tsx"), "utf8")

  expect(shell).toContain("<ComposerSkillChip")
  expect(shell).toContain("<PromptDeliveryNote")
})
