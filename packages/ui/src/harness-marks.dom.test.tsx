import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import {
  toolInventorySchema,
  type SkillSummary,
  type ToolInventory,
} from "@getdomovoi/protocol"

import { SkillBrowser } from "./skill-browser.js"
import { ToolInventoryView } from "./tool-inventory-view.js"

afterEach(cleanup)

// Ruling Q388 A: the design masks a mark for each third-party harness beside a
// skill's source and an agent's name. Those are other companies' marks, and the
// repository vendors only Domovoi's own, so Skills, Tools and the trust sheet
// name a source in text only until the marks are vendored and their use is
// checked. This pins that: no image, no masked glyph, no asset path, no inline
// vector other than a lucide icon, and no element styled or named as a mark,
// since a mark whose mask lives in the stylesheet leaves no trace in the markup.
function expectNoMarks(root: HTMLElement) {
  const markup = root.innerHTML
  expect(markup).not.toMatch(/<img\b/u)
  expect(markup).not.toMatch(/role="img"/u)
  expect(markup).not.toMatch(/mask(?:-image)?:/u)
  expect(markup).not.toMatch(/url\(/u)
  expect(markup).not.toMatch(/harness/u)
  expect(root.querySelectorAll('[style*="background"], [style*="mask"], picture, object')).toHaveLength(0)
  for (const vector of root.querySelectorAll("svg")) {
    expect(vector.classList.contains("lucide")).toBe(true)
  }
  for (const element of root.querySelectorAll("[class]")) {
    expect(element.getAttribute("class") ?? "").not.toMatch(/mark|logo|brand/iu)
  }
}

const digest = `sha256:${"a".repeat(64)}`

const skill = (id: string, source: SkillSummary["source"]): SkillSummary => ({
  id,
  name: `skill-${source}`,
  description: `A skill discovered from ${source}.`,
  path: `/home/dev/${source}/skills/${source}/SKILL.md`,
  scope: "user",
  source,
  manifest: { version: 1, capabilities: ["filesystem.read"] },
  contentDigest: digest,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
})

it("names a skill's source in text with no harness mark", async () => {
  const user = userEvent.setup()
  render(
    <SkillBrowser
      skills={[
        skill("skill-111111111111", "claude"),
        skill("skill-222222222222", "codex"),
        skill("skill-333333333333", "kilo"),
        skill("skill-444444444444", "agents"),
      ]}
      loading={false}
      error=""
      onOpenAudit={vi.fn()}
      onReadSkill={vi.fn()}
      projectId="project-acme-api"
      projectName="acme-api"
      enablements={[]}
      onSetSkillEnabled={vi.fn(async () => {})}
      onReviewSkill={vi.fn()}
      onPreviewSkillInstall={vi.fn()}
      onInstallSkill={vi.fn()}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByText("USER · CLAUDE")).toBeTruthy()
  expect(screen.getByText("USER · CODEX")).toBeTruthy()
  expect(screen.getByText("USER · KILO")).toBeTruthy()
  expectNoMarks(document.body)

  await user.click(screen.getByRole("button", { name: "Trust it for acme-api" }))
  expect(screen.getByRole("alertdialog")).toBeTruthy()
  expectNoMarks(document.body)
})

it("names each agent in Tools and in the trust sheet with no harness mark", async () => {
  const user = userEvent.setup()
  const inventory: ToolInventory = toolInventorySchema.parse({
    machine: { id: "machine-1", name: "mac-mini-m4", platform: "darwin", arch: "arm64", version: "0.9.4" },
    repository: {
      projectId: "project-acme",
      root: "~/src/acme-api",
      configDigest: digest,
      trust: { state: "untrusted", reason: "not-trusted" },
    },
    providers: [
      {
        provider: "claude-code",
        toolServers: "read-from-files",
        omittedEntries: 0,
        files: [{ path: ".mcp.json", source: "repository-file", state: "read" }],
        entries: [
          { kind: "tool-server", file: ".mcp.json", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: [], startsAtSessionStart: true, heldBack: true },
        ],
      },
      {
        provider: "codex",
        toolServers: "read-from-files",
        omittedEntries: 0,
        files: [{ path: ".codex/config.toml", source: "project-settings", state: "read" }],
        entries: [
          { kind: "hook", file: ".codex/config.toml", event: "SessionStart", command: "./scripts/bootstrap.sh", startsAtSessionStart: true, heldBack: true },
        ],
      },
    ],
  })
  render(
    <ToolInventoryView
      inventory={{ state: "loaded", inventory, readAt: new Date("2026-09-29T14:02:31") }}
      onRetry={vi.fn()}
      onTrust={vi.fn()}
    />,
  )

  expectNoMarks(document.body)

  await user.click(screen.getByRole("button", { name: "Review and trust" }))
  expect(screen.getByRole("dialog")).toBeTruthy()
  expectNoMarks(document.body)
})
