import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { SkillEnablementReview, SkillSummary } from "@getdomovoi/protocol"

import { SkillBrowser } from "./skill-browser.js"

afterEach(cleanup)

const reviewedDigest = `sha256:${"a".repeat(64)}`
const currentDigest = `sha256:${"b".repeat(64)}`

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "skill-111111111111",
  name: "repo-audit",
  description: "Audit repository quality and risk.",
  path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
  scope: "user",
  source: "agents",
  manifest: { version: 1, capabilities: ["filesystem.read"] },
  contentDigest: currentDigest,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
  ...over,
})

const review = (
  capabilities: SkillSummary["manifest"]["capabilities"],
): SkillEnablementReview => ({
  projectId: "project-acme-api",
  skillId: "skill-111111111111",
  enabled: true,
  contentDigest: reviewedDigest,
  manifest: { version: 1, capabilities },
  reviewedAt: "2026-09-01T10:00:00.000Z",
  reviewedBy: { client: "desktop" },
} as SkillEnablementReview)

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

async function openReview(overrides: Record<string, unknown>) {
  const user = userEvent.setup()
  render(<SkillBrowser {...props(overrides)} />)
  await user.click(screen.getByRole("button", { name: /Review & (enable|disable)/ }))
  return screen.getByRole("alertdialog")
}

// The consent flow has to be able to state what it is asking for. Approving a
// digest is not approving a change, so the dialog leads with what the skill can
// now do and the digest is evidence beneath it rather than the question.
it("leads the dialog with a capability the skill did not have before", async () => {
  const dialog = await openReview({
    skills: [skill({ manifest: { version: 1, capabilities: ["filesystem.read", "network.connect"] } })],
    enablements: [review(["filesystem.read"])],
  })

  const copy = dialog.textContent ?? ""
  expect(copy).toContain("Asks for network.connect, which it did not have before")
  expect(copy.indexOf("network.connect")).toBeLessThan(copy.indexOf(currentDigest))
})

// The common case, and the one that has to be fast. Someone who can re-approve
// this in a second is someone who still reads the dangerous one.
it("says plainly when only the instructions moved", async () => {
  const dialog = await openReview({ enablements: [review(["filesystem.read"])] })

  expect(dialog.textContent).toContain("No capability change, instructions only")
})

// An unknown baseline is not a clean one, so the dialog claims neither.
it("calls a never-reviewed skill a first review rather than unchanged", async () => {
  const dialog = await openReview({ enablements: [] })

  const copy = dialog.textContent ?? ""
  expect(copy).toContain("First review")
  expect(copy).not.toContain("No capability change")
})

// A screen that shows a capability summary and stays silent about its limits
// implies the answer to both is "no change". The manifest carries no scope, and
// the review keeps a digest rather than the bytes it covered.
it("says what the summary cannot answer rather than implying no change", async () => {
  const dialog = await openReview({ enablements: [review(["filesystem.read"])] })

  const copy = dialog.textContent ?? ""
  expect(copy).toContain("scope")
  expect(copy).toContain("cannot")
})

// The badge on the detail pane said only "Review is stale", which names that
// something changed and never what.
it("names the risk on the pane rather than only calling the review stale", async () => {
  render(<SkillBrowser {...props({
    skills: [skill({ manifest: { version: 1, capabilities: ["filesystem.read", "secrets.read"] } })],
    enablements: [review(["filesystem.read"])],
  })} />)

  expect(screen.getByText("Asks for secrets.read, which it did not have before")).toBeTruthy()
})
