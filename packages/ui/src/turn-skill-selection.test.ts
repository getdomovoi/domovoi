import type { SkillEnablementReview, SkillSummary } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import { selectableTurnSkills, turnSkillSelectionFor } from "./turn-skill-selection.js"

const digest = (character: string) => `sha256:${character.repeat(64)}` as const
const manifest = { version: 1 as const, capabilities: ["filesystem.read" as const] }

function skill(id: `skill-${string}`, name: string, contentDigest = digest("a")): SkillSummary {
  return {
    id,
    name,
    description: `${name} instructions`,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    source: "agents",
    manifest,
    contentDigest,
    signature: { state: "unsigned" },
    trust: { state: "untrusted", reason: "unsigned" },
  }
}

function review(document: SkillSummary, enabled = true): SkillEnablementReview {
  return {
    projectId: "project-one",
    skillId: document.id,
    enabled,
    contentDigest: document.contentDigest,
    manifest: document.manifest,
    reviewedAt: "2026-09-03T10:00:00.000Z",
    reviewedBy: { client: "desktop" },
  }
}

const alpha = skill("skill-aaaaaaaaaaaa", "plan-preview")
const beta = skill("skill-bbbbbbbbbbbb", "replay-audit", digest("b"))

it("offers only skills the project reviewed and enabled", () => {
  const offered = selectableTurnSkills(
    [alpha, beta],
    [review(alpha), review(beta, false)],
    "project-one",
  )

  expect(offered.map((entry) => entry.id)).toEqual([alpha.id])
})

it("sends nothing at all when the person has not chosen", () => {
  expect(turnSkillSelectionFor(undefined, [alpha])).toBeUndefined()
})

it("pins each chosen skill to the review it was chosen against", () => {
  expect(turnSkillSelectionFor(new Set([alpha.id]), [alpha, beta])).toEqual({
    mode: "turn-explicit",
    skills: [{ skillId: alpha.id, review: { contentDigest: alpha.contentDigest, manifest } }],
  })
})

it("sends an explicit empty selection when every skill was unchecked", () => {
  expect(turnSkillSelectionFor(new Set<string>(), [alpha])).toEqual({
    mode: "turn-explicit",
    skills: [],
  })
})

it("drops a chosen skill the catalog no longer offers rather than inventing a review", () => {
  expect(turnSkillSelectionFor(new Set([alpha.id, "skill-cccccccccccc"]), [alpha])).toEqual({
    mode: "turn-explicit",
    skills: [{ skillId: alpha.id, review: { contentDigest: alpha.contentDigest, manifest } }],
  })
})
