import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SkillDocument, SkillSummary } from "@getdomovoi/protocol"

import { SkillBrowser } from "./skill-browser"

afterEach(cleanup)

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("skill browser source requests", () => {
  it("keeps skill B source when deferred skill A resolves last", async () => {
    const user = userEvent.setup()
    const skillA = deferred<SkillDocument>()
    const skillB = deferred<SkillDocument>()
    const onReadSkill = vi.fn((id: string) => (
      id === skills[0]!.id ? skillA.promise : skillB.promise
    ))
    render(
      <SkillBrowser
        skills={skills}
        loading={false}
        error=""
        onBack={vi.fn()}
        onOpenAudit={vi.fn()}
        onReadSkill={onReadSkill}
        projectId="project-acme-api"
        enablements={[]}
        onSetSkillEnabled={vi.fn(async () => undefined)}
        onReviewSkill={vi.fn(async () => undefined)}
        onRetry={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "View SKILL.md" }))
    expect(screen.getByRole("dialog", { name: "design-studio / SKILL.md" })).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("Reading SKILL.md")
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()

    await user.click(screen.getByRole("button", { name: /^repo-audit/ }))
    await user.click(screen.getByRole("button", { name: "View SKILL.md" }))
    expect(onReadSkill.mock.calls).toEqual([[skills[0]!.id], [skills[1]!.id]])
    expect(screen.getByRole("dialog", { name: "repo-audit / SKILL.md" })).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("Reading SKILL.md")

    await act(async () => {
      skillB.resolve({ skill: skills[1]!, content: "source B" })
    })
    expect(screen.getByRole("dialog", { name: "repo-audit / SKILL.md" })).toBeTruthy()
    expect(screen.getByText("source B")).toBeTruthy()
    expect(screen.getByText(`${skills[1]!.path} · execution machine`)).toBeTruthy()
    expect(screen.queryByRole("status")).toBeNull()

    await act(async () => {
      skillA.resolve({ skill: skills[0]!, content: "source A" })
    })
    expect(screen.getByRole("dialog", { name: "repo-audit / SKILL.md" })).toBeTruthy()
    expect(screen.getByText("source B")).toBeTruthy()
    expect(screen.queryByText("source A")).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
  })
})
