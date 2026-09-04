import type {
  SkillEnablementReview,
  SkillSummary,
  TurnSkillSelection,
} from "@getdomovoi/protocol"

export type SelectableTurnSkill = Pick<SkillSummary, "id" | "name" | "contentDigest" | "manifest">

export function selectableTurnSkills(
  skills: readonly SkillSummary[],
  enablements: readonly SkillEnablementReview[],
  projectId: string | undefined,
): SelectableTurnSkill[] {
  if (!projectId) return []
  const enabled = new Set(
    enablements
      .filter((review) => review.projectId === projectId && review.enabled)
      .map((review) => review.skillId),
  )
  return skills
    .filter((skill) => enabled.has(skill.id))
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      contentDigest: skill.contentDigest,
      manifest: skill.manifest,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * An absent selection leaves today's project-default behaviour untouched. An
 * empty set is a deliberate "no skills this turn" and is sent as such.
 *
 * A chosen skill the catalog no longer offers is dropped rather than sent with
 * a guessed review: the daemon compares the digest and manifest a person chose
 * against, so inventing either would defeat that check.
 */
export function turnSkillSelectionFor(
  chosen: ReadonlySet<string> | undefined,
  skills: readonly SelectableTurnSkill[],
): TurnSkillSelection | undefined {
  if (!chosen) return undefined
  return {
    mode: "turn-explicit",
    skills: skills
      .filter((skill) => chosen.has(skill.id))
      .map((skill) => ({
        skillId: skill.id,
        review: { contentDigest: skill.contentDigest, manifest: skill.manifest },
      })),
  }
}
