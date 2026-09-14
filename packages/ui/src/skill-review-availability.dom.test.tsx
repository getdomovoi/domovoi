import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import type { SkillSummary } from "@getdomovoi/protocol"

import { SkillBrowser } from "./skill-browser.js"

afterEach(cleanup)

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "skill-111111111111",
  name: "repo-audit",
  description: "Audit repository quality and risk.",
  path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
  scope: "user",
  source: "agents",
  manifest: { version: 1, capabilities: ["filesystem.read"] },
  contentDigest: `sha256:${"a".repeat(64)}`,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
  ...over,
})

function props(overrides: Record<string, unknown> = {}) {
  return {
    skills: [skill()],
    loading: false,
    error: "",
    onOpenAudit: vi.fn(),
    onReadSkill: vi.fn(),
    projectId: "project-acme-api",
    enablements: [],
    onSetSkillEnabled: vi.fn(async () => {}),
    onReviewSkill: vi.fn(async () => skill()),
    onPreviewSkillInstall: vi.fn(),
    onInstallSkill: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof SkillBrowser>[0]
}

// A dead control cannot be told apart from a broken one. Enablement is per
// project, so with no project open the decision does not exist here at all: the
// control is absent and the reason is stated, rather than present and inert.
it("removes the review control with no project open, and says why", () => {
  render(<SkillBrowser {...props({ projectId: undefined })} />)

  expect(screen.queryByRole("button", { name: /Review & / })).toBeNull()
  expect(screen.getByText(/Enablement is per project/)).toBeTruthy()
})

it("offers the review control once a project is open", () => {
  render(<SkillBrowser {...props()} />)

  expect(screen.getByRole("button", { name: "Review & enable" })).toBeTruthy()
  expect(screen.queryByText(/Enablement is per project/)).toBeNull()
})

// A blocked skill is different: the decision exists and is refused. The control
// stays, so the refusal is visible, and the reason sits beside it rather than
// leaving a disabled button to be read as a bug.
it("keeps the control for a blocked skill and names the refusal", () => {
  render(<SkillBrowser {...props({
    skills: [skill({ trust: { state: "blocked", reason: "invalid-signature" } })],
  })} />)

  const control = screen.getByRole("button", { name: "Review & enable" })
  expect(control.hasAttribute("disabled")).toBe(true)
  expect(screen.getByText(/signature does not match its content/)).toBeTruthy()
})
