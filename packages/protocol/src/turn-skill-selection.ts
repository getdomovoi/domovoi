import {
  turnSkillSelectionRefusalSchema,
  type SkillEnablementReview,
  type SkillSummary,
  type TurnSkillSelection,
  type TurnSkillSelectionRefusal,
} from "./skills.js"

export type SelectableTurnSkill = Pick<SkillSummary, "id" | "name" | "contentDigest" | "manifest">

/**
 * The digest and manifest come from the enablement review rather than the
 * catalog, because the review is what the daemon compares a selection against:
 * it looks the skill up in the snapshot's enablements and refuses the turn when
 * the reference does not match that review. A catalog read at some other moment
 * is a second opinion nobody asked for, and disagreeing with the snapshot is
 * the one way a client can turn a valid choice into a refused one.
 *
 * The catalog is still what supplies the name, which is why a client holding a
 * stale one shows an old label rather than sending an invalid selection.
 */
export function selectableTurnSkills(
  skills: readonly SkillSummary[],
  enablements: readonly SkillEnablementReview[],
  projectId: string | undefined,
): SelectableTurnSkill[] {
  if (!projectId) return []
  const enabled = new Map(
    enablements
      .filter((review) => review.projectId === projectId && review.enabled)
      .map((review) => [review.skillId, review]),
  )
  return skills
    .flatMap((skill) => {
      const review = enabled.get(skill.id)
      if (!review) return []
      return [{
        id: skill.id,
        name: skill.name,
        contentDigest: review.contentDigest,
        manifest: review.manifest,
      }]
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * A skill the project has enabled but the catalog does not describe. The phone
 * asks for the catalog once and keeps it, so this is how it learns that what it
 * holds no longer covers what the snapshot says is enabled, without polling.
 */
export function enabledSkillsMissingFromCatalog(
  skills: readonly SkillSummary[],
  enablements: readonly SkillEnablementReview[],
  projectId: string | undefined,
): string[] {
  if (!projectId) return []
  const known = new Set(skills.map((skill) => skill.id))
  return enablements
    .filter((review) => review.projectId === projectId && review.enabled)
    .map((review) => review.skillId)
    .filter((skillId) => !known.has(skillId))
    .sort()
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
