import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { SkillSummary } from "@getdomovoi/protocol"

import { SkillBrowser, SkillSourceContent } from "./skill-browser"
import { filterSkills, groupSkills } from "./skill-browser-model"

const skills: SkillSummary[] = [
  {
    id: "skill-111111111111",
    name: "design-studio",
    description: "Create full-fidelity design variants.",
    path: "/home/dev/.agents/skills/design-studio/SKILL.md",
    scope: "user",
    source: "agents",
  },
  {
    id: "skill-222222222222",
    name: "repo-audit",
    description: "Audit repository quality and risk.",
    path: "/repo/.agents/skills/repo-audit/SKILL.md",
    scope: "project",
    source: "agents",
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
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain("2 discovered")
    expect(markup).toContain("design-studio")
    expect(markup).toContain("USER · AGENTS")
    expect(markup).toContain("/home/dev/.agents/skills/design-studio/SKILL.md")
    expect(markup).not.toContain("trusted")
    expect(markup).not.toContain("capabilities")
    expect(markup).toContain("View SKILL.md")
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
