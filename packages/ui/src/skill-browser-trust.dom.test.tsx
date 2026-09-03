import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { SkillSummary } from "@getdomovoi/protocol"

import { SkillBrowser } from "./skill-browser.js"

afterEach(cleanup)

const contentDigest = `sha256:${"a".repeat(64)}`

const skill: SkillSummary = {
  id: "skill-111111111111",
  name: "repo-audit",
  description: "Audit repository quality and risk.",
  path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
  scope: "user",
  source: "agents",
  manifest: { version: 1, capabilities: ["filesystem.read", "process.execute"] },
  contentDigest,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
}

function props(overrides: Partial<Parameters<typeof SkillBrowser>[0]> = {}) {
  return {
    skills: [skill],
    loading: false,
    error: "",
    onBack: vi.fn(),
    onOpenAudit: vi.fn(),
    onReadSkill: vi.fn(),
    projectId: "project-acme-api",
    enablements: [],
    onSetSkillEnabled: vi.fn(async () => {}),
    onReviewSkill: vi.fn(async () => skill),
    onRetry: vi.fn(),
    ...overrides,
  }
}

it("marks the selected skill reviewed on this machine against its exact digest", async () => {
  const user = userEvent.setup()
  const onReviewSkill = vi.fn(async () => skill)
  render(<SkillBrowser {...props({ onReviewSkill })} />)

  expect(screen.getByText("filesystem.read")).toBeTruthy()
  expect(screen.getByText("process.execute")).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Mark reviewed on this machine" }))

  expect(onReviewSkill).toHaveBeenCalledWith({
    id: skill.id,
    contentDigest,
    decision: "trust",
  })
})

it("revokes a manual review and never offers one for a blocked skill", async () => {
  const user = userEvent.setup()
  const onReviewSkill = vi.fn(async () => skill)
  const trusted: SkillSummary = {
    ...skill,
    trust: { state: "trusted", reason: "manual-review", authority: "manual review · desktop" },
  }
  const view = render(<SkillBrowser {...props({ skills: [trusted], onReviewSkill })} />)

  expect(screen.getByText("Trusted by manual review · desktop")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Revoke machine review" }))
  expect(onReviewSkill).toHaveBeenCalledWith({
    id: skill.id,
    contentDigest,
    decision: "revoke",
  })

  const blocked: SkillSummary = {
    ...skill,
    signature: { state: "invalid", reason: "malformed" },
    trust: { state: "blocked", reason: "invalid-signature" },
  }
  view.rerender(<SkillBrowser {...props({ skills: [blocked], onReviewSkill })} />)

  expect(screen.queryByRole("button", { name: "Mark reviewed on this machine" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Revoke machine review" })).toBeNull()
})
