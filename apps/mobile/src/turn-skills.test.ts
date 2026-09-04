import {
  selectableTurnSkills,
  turnSkillSelectionFor,
  type SkillEnablementReview,
  type SkillSummary,
} from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  missingSkillProblem,
  refusalMessage,
  skillPickerRows,
  skillSelectionLabel,
} from "./turn-skills"

const manifest = { version: 1 as const, capabilities: ["filesystem.read" as const] }

function skill(id: `skill-${string}`, name: string): SkillSummary {
  return {
    id,
    name,
    description: `${name} instructions`,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    source: "agents",
    manifest,
    contentDigest: `sha256:${"a".repeat(64)}`,
    signature: { state: "unsigned" },
    trust: { state: "untrusted", reason: "unsigned" },
  }
}

function review(document: SkillSummary): SkillEnablementReview {
  return {
    projectId: "project-acme-api",
    skillId: document.id,
    enabled: true,
    contentDigest: document.contentDigest,
    manifest: document.manifest,
    reviewedAt: "2026-09-03T10:00:00.000Z",
    reviewedBy: { client: "phone" },
  }
}

const audit = skill("skill-aaaaaaaaaaaa", "repo-audit")
const preview = skill("skill-bbbbbbbbbbbb", "plan-preview")

describe("skillPickerRows", () => {
  it("marks what is chosen and carries the description the catalog holds", () => {
    const offered = selectableTurnSkills([audit, preview], [review(audit), review(preview)], "project-acme-api")
    const descriptions = new Map([[audit.id, audit.description], [preview.id, preview.description]])

    const rows = skillPickerRows(offered, new Set([audit.id]), descriptions)

    expect(rows.map((row) => [row.name, row.selected])).toEqual([
      ["plan-preview", false],
      ["repo-audit", true],
    ])
    expect(rows[1]?.description).toBe("repo-audit instructions")
  })

  it("selects nothing when the person has not chosen at all", () => {
    const offered = selectableTurnSkills([audit], [review(audit)], "project-acme-api")

    expect(skillPickerRows(offered, undefined, new Map()).every((row) => !row.selected)).toBe(true)
  })
})

describe("skillSelectionLabel", () => {
  it("tells apart leaving the defaults alone from choosing no skills", () => {
    expect(skillSelectionLabel(undefined)).toBe("Project default")
    expect(skillSelectionLabel(new Set())).toBe("No skills")
    expect(skillSelectionLabel(new Set(["a", "b"]))).toBe("2 selected")
  })
})

describe("missingSkillProblem", () => {
  it("refuses the send when a chosen skill has left the catalog", () => {
    const offered = selectableTurnSkills([audit], [review(audit)], "project-acme-api")
    const { selection, missing } = turnSkillSelectionFor(
      new Set([audit.id, preview.id]),
      offered,
    )

    // The selection the daemon would have accepted is one skill short of what
    // was asked for, which is exactly the send this must stop.
    expect(selection?.skills).toHaveLength(1)
    expect(missingSkillProblem(missing)).toContain(preview.id)
  })

  it("says nothing when every chosen skill is still offered", () => {
    expect(missingSkillProblem([])).toBeUndefined()
  })

  it("lists every missing skill rather than only the first", () => {
    const problem = missingSkillProblem(["skill-one", "skill-two"])

    expect(problem).toContain("skill-one")
    expect(problem).toContain("skill-two")
  })
})

describe("refusalMessage", () => {
  it("names the skill and says nothing was sent", () => {
    const message = refusalMessage({
      kind: "turn-skill-selection-refused",
      skillId: audit.id,
      reason: "review-changed",
    })

    expect(message).toContain(audit.id)
    expect(message).toContain("Nothing was sent")
  })
})
