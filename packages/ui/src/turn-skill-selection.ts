import {
  turnSkillSelectionRefusalSchema,
  type SkillEnablementReview,
  type SkillSummary,
  type TurnSkillSelection,
  type TurnSkillSelectionRefusal,
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
 * A chosen skill the catalog no longer offers is reported as missing rather
 * than dropped. Dropping it would change what the person asked for into a
 * smaller selection the daemon would accept without complaint, and an explicit
 * selection that lost every skill would send "no skills this turn" instead.
 * The review cannot be invented either: the daemon compares the digest and
 * manifest a person chose against, so a guess would defeat that check.
 */
export function turnSkillSelectionFor(
  chosen: ReadonlySet<string> | undefined,
  skills: readonly SelectableTurnSkill[],
): { selection: TurnSkillSelection | undefined, missing: string[] } {
  if (!chosen) return { selection: undefined, missing: [] }
  const offered = new Map(skills.map((skill) => [skill.id, skill]))
  const missing = [...chosen].filter((skillId) => !offered.has(skillId)).sort()
  return {
    selection: {
      mode: "turn-explicit",
      skills: skills
        .filter((skill) => chosen.has(skill.id))
        .map((skill) => ({
          skillId: skill.id,
          review: { contentDigest: skill.contentDigest, manifest: skill.manifest },
        })),
    },
    missing,
  }
}

/**
 * A refused send carries the skill and the reason as RPC error data. Anything
 * else is an ordinary failure, so the chip marks nothing rather than guessing.
 */
export function turnSkillRefusalFrom(cause: unknown): TurnSkillSelectionRefusal | undefined {
  if (typeof cause !== "object" || cause === null) return undefined
  const data = (cause as { data?: unknown }).data
  const parsed = turnSkillSelectionRefusalSchema.safeParse(data)
  return parsed.success ? parsed.data : undefined
}
