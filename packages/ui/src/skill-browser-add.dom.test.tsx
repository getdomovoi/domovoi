import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { skillInstallErrorCode, type SkillInstallPreview, type SkillSummary } from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"
import { SkillBrowser } from "./skill-browser.js"

afterEach(cleanup)

const contentDigest = `sha256:${"a".repeat(64)}`
const sourceDigest = `sha256:${"b".repeat(64)}`

const existing: SkillSummary = {
  id: "skill-111111111111",
  name: "repo-audit",
  description: "Audit repository quality and risk.",
  path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
  scope: "user",
  source: "agents",
  manifest: { version: 1, capabilities: [] },
  contentDigest,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
}

const preview: SkillInstallPreview = {
  source: { kind: "path", path: "/home/dev/work/skills/pr-triage" },
  name: "pr-triage",
  description: "Triage pull requests.",
  manifest: { version: 1, capabilities: ["filesystem.read", "process.execute"] },
  contentDigest,
  sourceDigest,
  signature: {
    state: "unverified",
    algorithm: "ed25519",
    keyId: "ed25519:0123456789abcdef",
    value: "ZGVjbGFyZWQtc2lnbmF0dXJl",
  },
  trust: { state: "untrusted", reason: "unverified-signature" },
  files: [
    { path: "SKILL.md", bytes: 2_100 },
    { path: "SKILL.md.sig", bytes: 240 },
    { path: "scripts/triage.ts", bytes: 6_400 },
  ],
  targets: [
    { scope: "project", path: "/repo/.domovoi/skills/pr-triage", state: "available" },
    { scope: "user", path: "/home/dev/.domovoi/skills/pr-triage", state: "available" },
  ],
  refusals: [],
}

const installed: SkillSummary = {
  ...existing,
  id: "skill-222222222222",
  name: "pr-triage",
  description: "Triage pull requests.",
  path: "/home/dev/.domovoi/skills/pr-triage/SKILL.md",
  source: "domovoi",
  manifest: preview.manifest,
}

function props(overrides: Partial<Parameters<typeof SkillBrowser>[0]> = {}) {
  return {
    skills: [existing],
    loading: false,
    error: "",
    onOpenAudit: vi.fn(),
    onReadSkill: vi.fn(),
    projectId: "project-acme-api",
    enablements: [],
    onSetSkillEnabled: vi.fn(async () => {}),
    onReviewSkill: vi.fn(async () => existing),
    onPreviewSkillInstall: vi.fn(async () => preview),
    onInstallSkill: vi.fn(async () => installed),
    onRetry: vi.fn(),
    ...overrides,
  }
}

async function openReview(user: ReturnType<typeof userEvent.setup>, path = preview.source.path) {
  await user.click(screen.getByRole("button", { name: "Add skill" }))
  const dialog = screen.getByRole("dialog", { name: "Add a skill" })
  await user.type(within(dialog).getByLabelText("Folder on this machine"), path)
  await user.click(within(dialog).getByRole("button", { name: "Review" }))
  return dialog
}

it("reviews a folder before installing it to a chosen scope", async () => {
  const user = userEvent.setup()
  const onPreviewSkillInstall = vi.fn(async () => preview)
  const onInstallSkill = vi.fn(async () => installed)
  render(<SkillBrowser {...props({ onPreviewSkillInstall, onInstallSkill })} />)

  const dialog = await openReview(user)

  expect(onPreviewSkillInstall).toHaveBeenCalledWith({ kind: "path", path: preview.source.path })
  expect(within(dialog).getByText("pr-triage")).toBeTruthy()
  expect(within(dialog).getByText("Triage pull requests.")).toBeTruthy()
  expect(within(dialog).getByText("filesystem.read")).toBeTruthy()
  expect(within(dialog).getByText("process.execute")).toBeTruthy()
  expect(within(dialog).getByText("Signed by untrusted key ed25519:0123456789abcdef")).toBeTruthy()
  expect(within(dialog).getByText(sourceDigest)).toBeTruthy()
  expect(within(dialog).getByText("scripts/triage.ts")).toBeTruthy()
  expect(within(dialog).getByRole("radio", { name: "This project only" }).getAttribute("aria-checked")).toBe("true")
  expect(within(dialog).getByText("Installs to /repo/.domovoi/skills/pr-triage")).toBeTruthy()

  await user.click(within(dialog).getByRole("radio", { name: "All my projects" }))
  expect(within(dialog).getByText("Installs to /home/dev/.domovoi/skills/pr-triage")).toBeTruthy()
  await user.click(within(dialog).getByRole("button", { name: "Install" }))

  expect(onInstallSkill).toHaveBeenCalledWith({
    source: { kind: "path", path: preview.source.path },
    scope: "user",
    sourceDigest,
  })
  expect(screen.queryByRole("dialog", { name: "Add a skill" })).toBeNull()
})

it("shows refusals from the review and from the install in place", async () => {
  const user = userEvent.setup()
  const refused: SkillInstallPreview = {
    ...preview,
    trust: { state: "blocked", reason: "invalid-signature" },
    signature: { state: "invalid", reason: "verification-failed" },
    targets: [
      { scope: "project", path: "/repo/.domovoi/skills/pr-triage", state: "conflict" },
      { scope: "user", path: "/home/dev/.domovoi/skills/pr-triage", state: "available" },
    ],
    refusals: [
      { kind: "skill-install-refused", reason: "blocked" },
      { kind: "skill-install-refused", reason: "symlink-escapes-source", path: "scripts/escape" },
    ],
  }
  const onPreviewSkillInstall = vi.fn(async () => refused)
  const onInstallSkill = vi.fn(async () => installed)
  const view = render(<SkillBrowser {...props({ onPreviewSkillInstall, onInstallSkill })} />)

  const dialog = await openReview(user)

  const alert = within(dialog).getByRole("alert")
  expect(alert.textContent).toContain("Install refused")
  expect(alert.textContent).toContain("The signature is invalid, so this skill is blocked")
  expect(alert.textContent).toContain("scripts/escape links to a file outside the folder")
  expect(within(dialog).getByText("Signature invalid")).toBeTruthy()
  expect(within(dialog).getByRole("radio", { name: "This project only" }).hasAttribute("disabled")).toBe(true)
  expect(within(dialog).getByRole("radio", { name: "All my projects" }).getAttribute("aria-checked")).toBe("true")
  expect(within(dialog).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(true)
  expect(onInstallSkill).not.toHaveBeenCalled()

  cleanup()
  view.unmount()
  const stale = vi.fn(async () => {
    throw new DaemonRpcError(skillInstallErrorCode, "Skill source changed since it was reviewed; review it again", {
      kind: "skill-install-refused",
      reason: "source-changed",
    })
  })
  render(<SkillBrowser {...props({ onInstallSkill: stale })} />)
  const again = await openReview(user)
  await user.click(within(again).getByRole("button", { name: "Install" }))

  expect(stale).toHaveBeenCalledOnce()
  const refusal = within(again).getByRole("alert")
  expect(refusal.textContent).toContain("Install refused")
  expect(refusal.textContent).toContain("The folder changed since it was reviewed. Review it again.")
  expect(screen.getByRole("dialog", { name: "Add a skill" })).toBeTruthy()
})
