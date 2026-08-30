import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { SkillSummary } from "@getdomovoi/protocol"

import { SkillBrowser, SkillSourceContent } from "./skill-browser"
import { filterSkills, groupSkills } from "./skill-browser-model"

const skillSecurityMetadata = {
  manifest: { version: 1 as const, capabilities: [] },
  contentDigest: `sha256:${"a".repeat(64)}`,
  signature: { state: "unsigned" as const },
  trust: { state: "untrusted" as const, reason: "unsigned" as const },
}

const skills: SkillSummary[] = [
  {
    id: "skill-111111111111",
    name: "design-studio",
    description: "Create full-fidelity design variants.",
    path: "/home/dev/.agents/skills/design-studio/SKILL.md",
    scope: "user",
    source: "agents",
    ...skillSecurityMetadata,
  },
  {
    id: "skill-222222222222",
    name: "repo-audit",
    description: "Audit repository quality and risk.",
    path: "/repo/.agents/skills/repo-audit/SKILL.md",
    scope: "project",
    source: "agents",
    ...skillSecurityMetadata,
  },
]

describe("skill browser", () => {
  it("groups skills by scope and source without claiming trust", () => {
    expect(groupSkills(skills).map((group) => group.label)).toEqual([
      "PROJECT · AGENTS",
      "USER · AGENTS",
    ])
  })

  it("searches names, descriptions, paths, and provenance", () => {
    expect(filterSkills(skills, "full-fidelity")).toEqual([skills[0]])
    expect(filterSkills(skills, "/repo/")).toEqual([skills[1]])
    expect(filterSkills(skills, "project agents")).toEqual([skills[1]])
  })

  it("renders discovered provenance and selected skill details", () => {
    const markup = renderToStaticMarkup(
      <SkillBrowser
        skills={skills}
        loading={false}
        error=""
        onBack={vi.fn()}
        onOpenAudit={vi.fn()}
        onReadSkill={vi.fn()}
        projectId="project-acme-api"
        enablements={[]}
        onSetSkillEnabled={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain("2 discovered")
    expect(markup).toContain("design-studio")
    expect(markup).toContain("USER · AGENTS")
    expect(markup).toContain("/home/dev/.agents/skills/design-studio/SKILL.md")
    expect(markup).not.toContain("trusted")
    expect(markup).toContain("View SKILL.md")
    expect(markup).toContain("Review &amp; enable")
    expect(markup).toContain("sha256:")
    expect(markup).toContain("No declared capabilities")
    expect(markup.match(/>Audit log<\/button>/g)).toHaveLength(2)
  })

  it("shows project-scoped reviewed state without granting trust", () => {
    const markup = renderToStaticMarkup(
      <SkillBrowser
        skills={skills}
        loading={false}
        error=""
        onBack={vi.fn()}
        onOpenAudit={vi.fn()}
        onReadSkill={vi.fn()}
        projectId="project-acme-api"
        enablements={[{
          projectId: "project-acme-api",
          skillId: skills[0]!.id,
          enabled: true,
          contentDigest: skills[0]!.contentDigest,
          manifest: skills[0]!.manifest,
          reviewedAt: "2026-08-30T12:00:00.000Z",
          reviewedBy: { client: "desktop", clientId: "desktop-one" },
        }]}
        onSetSkillEnabled={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain("Enabled for this project")
    expect(markup).toContain("Review &amp; disable")
    expect(markup).toContain("Enablement does not change signature or trust state")
  })

  it("shows metadata-only machine comparison without a distribution action", () => {
    const metadata = {
      id: skills[0]!.id,
      name: skills[0]!.name,
      scope: skills[0]!.scope,
      source: skills[0]!.source,
      manifest: skills[0]!.manifest,
      contentDigest: skills[0]!.contentDigest,
      signature: { state: "unsigned" as const },
      trust: { state: "untrusted" as const, reason: "unsigned" as const },
    }
    const markup = renderToStaticMarkup(
      <SkillBrowser
        skills={skills}
        inventorySources={[
          { state: "available", inventory: { machine: { id: "machine-a", name: "Alpha", platform: "linux", arch: "x64", version: "0.0.1" }, skills: [metadata] } },
          { state: "unknown", machine: { id: "machine-b", name: "Beta", platform: "darwin", arch: "arm64", version: "0.0.1" } },
        ]}
        loading={false}
        error=""
        onBack={vi.fn()}
        onOpenAudit={vi.fn()}
        onReadSkill={vi.fn()}
        projectId="project-acme-api"
        enablements={[]}
        onSetSkillEnabled={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain("Machine comparison")
    expect(markup).toContain("Untrusted")
    expect(markup).toContain("Unknown")
    expect(markup).toContain("never copies, installs, or syncs skills")
    expect(markup).not.toMatch(/>Copy<|>Install<|>Sync</)
  })

  it("renders bounded source returned by the daemon", () => {
    const markup = renderToStaticMarkup(
      <SkillSourceContent
        skill={skills[0]!}
        content="---\nname: design-studio\n---\n"
        loading={false}
        error=""
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain("name: design-studio")
    expect(markup).toContain("execution machine")
  })
})
