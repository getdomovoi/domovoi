import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { SkillEnablementReview, SkillSummary } from "@getdomovoi/protocol"

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

const trusted: SkillSummary = {
  ...skill,
  trust: { state: "trusted", reason: "manual-review", authority: "manual review · desktop" },
}

const enabled: SkillEnablementReview = {
  projectId: "project-acme-api",
  skillId: skill.id,
  enabled: true,
  contentDigest,
  manifest: skill.manifest,
  reviewedAt: "2026-08-12T14:02:00.000Z",
  reviewedBy: { client: "desktop", clientId: "desktop-one" },
}

function props(overrides: Partial<Parameters<typeof SkillBrowser>[0]> = {}) {
  return {
    skills: [skill],
    loading: false,
    error: "",
    onOpenAudit: vi.fn(),
    onReadSkill: vi.fn(),
    projectId: "project-acme-api",
    projectName: "acme-api",
    enablements: [],
    onSetSkillEnabled: vi.fn(async () => {}),
    onReviewSkill: vi.fn(async () => skill),
    onPreviewSkillInstall: vi.fn(),
    onInstallSkill: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
}

// Ruling Q359 A: trust and enablement are one decision. "Trust it for
// <project>" enables the skill for the project and records a manual review of
// the same digest, through the two existing RPCs in sequence. The project grant
// goes first, so a failure part-way leaves the narrower state, never a machine
// review without the enablement it was asked for.
it("trusts a skill for the project by enabling it and then recording the machine review", async () => {
  const user = userEvent.setup()
  const onSetSkillEnabled = vi.fn(async () => {})
  const onReviewSkill = vi.fn(async () => trusted)
  render(<SkillBrowser {...props({ onSetSkillEnabled, onReviewSkill })} />)

  expect(screen.queryByRole("button", { name: "Mark reviewed on this machine" })).toBeNull()
  expect(screen.queryByRole("button", { name: /Review & / })).toBeNull()
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull()
  expect(screen.getByText("Trust and revoke are the only two decisions.")).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Trust it for acme-api" }))
  const dialog = screen.getByRole("alertdialog")
  expect(dialog.textContent).toContain(contentDigest)
  expect(dialog.textContent).not.toContain("does not grant trust")
  await user.click(within(dialog).getByRole("button", { name: "Trust it for acme-api" }))

  expect(onSetSkillEnabled).toHaveBeenCalledWith({
    id: skill.id,
    enabled: true,
    contentDigest,
    manifest: skill.manifest,
  })
  expect(onReviewSkill).toHaveBeenCalledWith({
    id: skill.id,
    contentDigest,
    decision: "trust",
  })
  expect(onSetSkillEnabled.mock.invocationCallOrder[0]).toBeLessThan(onReviewSkill.mock.invocationCallOrder[0] ?? 0)
})

it("stops at the project grant when enabling fails, and names the failure", async () => {
  const user = userEvent.setup()
  const onSetSkillEnabled = vi.fn(async () => { throw new Error("Skill content changed; review it again") })
  const onReviewSkill = vi.fn(async () => trusted)
  render(<SkillBrowser {...props({ onSetSkillEnabled, onReviewSkill })} />)

  await user.click(screen.getByRole("button", { name: "Trust it for acme-api" }))
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Trust it for acme-api" }))

  expect(onSetSkillEnabled).toHaveBeenCalledOnce()
  expect(onReviewSkill).not.toHaveBeenCalled()
  expect(screen.getByText("Skill content changed; review it again")).toBeTruthy()
})

// The project grant succeeded and the machine review did not, so the skill is
// now enabled for the project without the trust the button promised. The cause
// alone would hide the approval fact that was recorded.
it("states the recorded enablement when only the machine review fails", async () => {
  const user = userEvent.setup()
  const onSetSkillEnabled = vi.fn(async () => {})
  const onReviewSkill = vi.fn(async () => { throw new Error("Manual skill review is unavailable") })
  render(<SkillBrowser {...props({ onSetSkillEnabled, onReviewSkill })} />)

  await user.click(screen.getByRole("button", { name: "Trust it for acme-api" }))
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Trust it for acme-api" }))

  expect(onSetSkillEnabled).toHaveBeenCalledOnce()
  expect(onReviewSkill).toHaveBeenCalledOnce()
  const alert = screen.getByRole("alert")
  expect(alert.textContent).toContain("Manual skill review is unavailable")
  expect(alert.textContent).toContain("Enablement for acme-api was recorded. The machine review was not, so Build auto still excludes it.")
  expect(alert.textContent).toContain("Trust it for acme-api again repeats both steps. Revoke takes back the enablement for acme-api.")
})

it("does not record a second machine review for a digest already trusted", async () => {
  const user = userEvent.setup()
  const onSetSkillEnabled = vi.fn(async () => {})
  const onReviewSkill = vi.fn(async () => trusted)
  render(<SkillBrowser {...props({ skills: [trusted], onSetSkillEnabled, onReviewSkill })} />)

  await user.click(screen.getByRole("button", { name: "Trust it for acme-api" }))
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Trust it for acme-api" }))

  expect(onSetSkillEnabled).toHaveBeenCalledOnce()
  expect(onReviewSkill).not.toHaveBeenCalled()
})

// Revoke is project-only. The machine review stays because it also governs
// Build auto in other projects, so revoking it here would reach past the
// project the button names.
it("revokes for the project only and leaves the machine review in place", async () => {
  const user = userEvent.setup()
  const onSetSkillEnabled = vi.fn(async () => {})
  const onReviewSkill = vi.fn(async () => trusted)
  render(<SkillBrowser {...props({ skills: [trusted], enablements: [enabled], onSetSkillEnabled, onReviewSkill })} />)

  expect(screen.getByText("Trusted by manual review · desktop")).toBeTruthy()
  expect(screen.getByText(/^acme-api · reviewed \d{2} Aug \d{2}:\d{2} by desktop$/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Revoke machine review" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Trust it for acme-api" })).toBeNull()

  await user.click(screen.getByRole("button", { name: "Revoke" }))

  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(onSetSkillEnabled).toHaveBeenCalledWith({
    id: skill.id,
    enabled: false,
    contentDigest,
    manifest: skill.manifest,
  })
  expect(onReviewSkill).not.toHaveBeenCalled()
})

// The dialog's action closes it in the same click, while the button that opened
// it is disabled for the pending RPCs, so the dialog's focus return has nowhere
// to land. Once the promise settles, focus goes to the result: the failure
// alert, or the control the decision leaves offered.
it("moves focus to the failure alert when the trust decision settles", async () => {
  const user = userEvent.setup()
  const onReviewSkill = vi.fn(async () => { throw new Error("Manual skill review is unavailable") })
  render(<SkillBrowser {...props({ onReviewSkill })} />)

  await user.click(screen.getByRole("button", { name: "Trust it for acme-api" }))
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Trust it for acme-api" }))

  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole("alert"))
})

it("moves focus back to the decision when the trust dialog settles", async () => {
  const user = userEvent.setup()
  render(<SkillBrowser {...props()} />)

  await user.click(screen.getByRole("button", { name: "Trust it for acme-api" }))
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Trust it for acme-api" }))

  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Trust it for acme-api" }))
})

it("keeps focus on Revoke when revoking settles", async () => {
  const user = userEvent.setup()
  render(<SkillBrowser {...props({ skills: [trusted], enablements: [enabled] })} />)

  await user.click(screen.getByRole("button", { name: "Revoke" }))

  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revoke" }))
})

it("names the revoke in the title when revoking fails", async () => {
  const user = userEvent.setup()
  const onSetSkillEnabled = vi.fn(async () => { throw new Error("Skill content changed; review it again") })
  render(<SkillBrowser {...props({ skills: [trusted], enablements: [enabled], onSetSkillEnabled })} />)

  await user.click(screen.getByRole("button", { name: "Revoke" }))

  const alert = screen.getByRole("alert")
  expect(within(alert).getByText("Revoke failed")).toBeTruthy()
  expect(within(alert).getByText("Skill content changed; review it again")).toBeTruthy()
  expect(alert.textContent).not.toContain("Review failed")
})

// Enabled but untrusted is a half-recorded decision (the review call failed, or
// the enablement predates the one-decision rule). Both halves stay offered so
// it can be finished or taken back.
it("offers trust beside revoke while the enablement has no machine review", () => {
  render(<SkillBrowser {...props({ enablements: [enabled] })} />)

  expect(screen.getByRole("button", { name: "Trust it for acme-api" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy()
})

it("refuses trust for a blocked skill and never offers a machine review", () => {
  const blocked: SkillSummary = {
    ...skill,
    signature: { state: "invalid", reason: "malformed" },
    trust: { state: "blocked", reason: "invalid-signature" },
  }
  render(<SkillBrowser {...props({ skills: [blocked] })} />)

  expect(screen.getByRole("button", { name: "Trust it for acme-api" }).hasAttribute("disabled")).toBe(true)
  expect(screen.queryByRole("button", { name: "Mark reviewed on this machine" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Revoke machine review" })).toBeNull()
})
