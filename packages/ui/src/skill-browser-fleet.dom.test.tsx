import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import type { SkillInventoryEntry, SkillSummary } from "@getdomovoi/protocol"

import { SkillBrowser } from "./skill-browser.js"

afterEach(cleanup)

const skill: SkillSummary = {
  id: "skill-111111111111",
  name: "repo-audit",
  description: "Audit repository quality and risk.",
  path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
  scope: "user",
  source: "agents",
  manifest: { version: 1, capabilities: [] },
  contentDigest: `sha256:${"a".repeat(64)}`,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
}

function entry(name: string, id: string): SkillInventoryEntry {
  return {
    id,
    name,
    scope: "user",
    source: "agents",
    manifest: { version: 1, capabilities: [] },
    contentDigest: `sha256:${"a".repeat(64)}`,
    signature: { state: "unsigned" },
    trust: { state: "untrusted", reason: "unsigned" },
  }
}

const machine = (id: string, name: string) => ({ id, name, platform: "linux", arch: "x64", version: "0.9.4" })

// The section compares the machines this one is not: one row for each, with
// what its inventory says, rather than one row for every skill on every
// machine with no skill named. The first source is this machine
// (collectFleetInventories puts it there).
it("draws one row per other machine, never this one, with its platform and inventory", () => {
  render(
    <SkillBrowser
      skills={[skill]}
      inventorySources={[
        { state: "available", inventory: { machine: machine("machine-local", "this-mac"), skills: [entry("repo-audit", "skill-111111111111"), entry("pdf-forms", "skill-222222222222"), entry("design-studio", "skill-333333333333")] } },
        { state: "available", inventory: { machine: machine("machine-h", "hetzner-cx42"), skills: [entry("repo-audit", "skill-444444444444"), entry("pdf-forms", "skill-555555555555")] } },
        { state: "unreachable", machine: machine("machine-w", "wsl-ubuntu-24") },
        { state: "unknown", machine: machine("machine-o", "old-daemon") },
      ]}
      loading={false}
      error=""
      onOpenAudit={vi.fn()}
      onReadSkill={vi.fn()}
      projectId="project-acme-api"
      enablements={[]}
      onSetSkillEnabled={vi.fn()}
      onReviewSkill={vi.fn()}
      onPreviewSkillInstall={vi.fn()}
      onInstallSkill={vi.fn()}
      onRetry={vi.fn()}
    />,
  )

  const section = screen.getByRole("heading", { name: "Inventories from your other machines" }).closest("section")!
  expect(within(section).queryByText("this-mac")).toBeNull()
  expect(within(section).getAllByText("hetzner-cx42")).toHaveLength(1)
  const list = screen.getByRole("list", { name: "Inventories from your other machines" })
  const rows = within(list).getAllByRole("listitem").map((row) => row.textContent)
  expect(rows).toEqual([
    "hetzner-cx42linux · x64 · 0.9.4inventory available, 2 skills",
    "old-daemonlinux · x64 · 0.9.4unknown, it returned no inventory",
    "wsl-ubuntu-24linux · x64 · 0.9.4unreachable, no inventory read",
  ])
  expect(within(list).queryByText("this-mac")).toBeNull()
})

it("says no other machine reports skills when only this machine has an inventory", () => {
  render(
    <SkillBrowser
      skills={[skill]}
      inventorySources={[{ state: "available", inventory: { machine: machine("machine-local", "this-mac"), skills: [entry("repo-audit", "skill-111111111111")] } }]}
      loading={false}
      error=""
      onOpenAudit={vi.fn()}
      onReadSkill={vi.fn()}
      projectId="project-acme-api"
      enablements={[]}
      onSetSkillEnabled={vi.fn()}
      onReviewSkill={vi.fn()}
      onPreviewSkillInstall={vi.fn()}
      onInstallSkill={vi.fn()}
      onRetry={vi.fn()}
    />,
  )
  expect(screen.queryByRole("list", { name: "Inventories from your other machines" })).toBeNull()
  expect(screen.getAllByText("No other paired machine reports the skills capability.").length).toBeGreaterThan(0)
})
