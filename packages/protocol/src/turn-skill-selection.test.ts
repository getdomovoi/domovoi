import type { SkillEnablementReview, SkillSummary } from "./skills.js"
import { expect, it } from "vitest"

import {
  enabledSkillsMissingFromCatalog,
  selectableTurnSkills,
  turnSkillRefusalFrom,
  turnSkillSelectionFor,
} from "./turn-skill-selection.js"

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

it("pins each offer to the review the daemon will compare it against", () => {
  // The catalog has moved on from what was reviewed. The daemon looks the skill
  // up in the snapshot's enablements and refuses a reference that disagrees
  // with it, so the review is the only digest worth sending.
  const edited = { ...alpha, contentDigest: digest("f") }

  const offered = selectableTurnSkills([edited], [review(alpha)], "project-one")

  expect(offered[0]?.contentDigest).toBe(alpha.contentDigest)
  expect(offered[0]?.name).toBe(edited.name)
})

it("names an enabled skill the catalog does not describe, without being asked twice", () => {
  expect(enabledSkillsMissingFromCatalog([alpha], [review(alpha), review(beta)], "project-one"))
    .toEqual([beta.id])
  expect(enabledSkillsMissingFromCatalog([alpha, beta], [review(alpha), review(beta)], "project-one"))
    .toEqual([])
})

it("reports nothing missing when a skill is enabled for another project", () => {
  const elsewhere = { ...review(beta), projectId: "project-two" }

  expect(enabledSkillsMissingFromCatalog([alpha], [review(alpha), elsewhere], "project-one"))
    .toEqual([])
  expect(enabledSkillsMissingFromCatalog([alpha], [review(alpha)], undefined)).toEqual([])
})

it("orders what it offers by name, so the same catalog reads the same way twice", () => {
  const zulu = skill("skill-cccccccccccc", "zulu-check", digest("c"))
  const offered = selectableTurnSkills(
    [zulu, beta, alpha],
    [review(zulu), review(beta), review(alpha)],
    "project-one",
  )

  expect(offered.map((entry) => entry.name)).toEqual(["plan-preview", "replay-audit", "zulu-check"])
})

it("offers nothing when no project is open, because enablement is per project", () => {
  expect(selectableTurnSkills([alpha], [review(alpha)], undefined)).toEqual([])
})

it("sends nothing at all when the person has not chosen", () => {
  expect(turnSkillSelectionFor(undefined, [alpha])).toEqual({ selection: undefined, missing: [] })
})

it("pins each chosen skill to the review it was chosen against", () => {
  expect(turnSkillSelectionFor(new Set([alpha.id]), [alpha, beta])).toEqual({
    selection: {
      mode: "turn-explicit",
      skills: [{ skillId: alpha.id, review: { contentDigest: alpha.contentDigest, manifest } }],
    },
    missing: [],
  })
})

it("sends an explicit empty selection when every skill was unchecked", () => {
  expect(turnSkillSelectionFor(new Set<string>(), [alpha])).toEqual({
    selection: { mode: "turn-explicit", skills: [] },
    missing: [],
  })
})



it("reads a refusal out of a failed send and ignores anything else", () => {
  const refused = Object.assign(new Error("Selected skill changed"), {
    data: {
      kind: "turn-skill-selection-refused",
      skillId: alpha.id,
      reason: "review-changed",
    },
  })

  expect(turnSkillRefusalFrom(refused)).toEqual({
    kind: "turn-skill-selection-refused",
    skillId: alpha.id,
    reason: "review-changed",
  })
  expect(turnSkillRefusalFrom(new Error("Daemon connection is not open"))).toBeUndefined()
  expect(turnSkillRefusalFrom(undefined)).toBeUndefined()
})

it("reports a chosen skill the catalog lost rather than sending a smaller selection", () => {
  expect(turnSkillSelectionFor(new Set([alpha.id, "skill-cccccccccccc"]), [alpha])).toEqual({
    selection: {
      mode: "turn-explicit",
      skills: [{ skillId: alpha.id, review: { contentDigest: alpha.contentDigest, manifest } }],
    },
    missing: ["skill-cccccccccccc"],
  })
})

it("reports every chosen skill as missing rather than sending an explicit none", () => {
  expect(turnSkillSelectionFor(new Set([alpha.id]), [])).toEqual({
    selection: { mode: "turn-explicit", skills: [] },
    missing: [alpha.id],
  })
})
