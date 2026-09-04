import type { SelectableTurnSkill, TurnSkillSelectionRefusal } from "@getdomovoi/protocol"

export type SkillPickerRow = {
  id: string
  name: string
  description: string
  selected: boolean
}

export function skillPickerRows(
  offered: readonly SelectableTurnSkill[],
  chosen: ReadonlySet<string> | undefined,
  // The catalog carries a description the selectable shape drops, so the phone
  // is handed it separately rather than widening what selection depends on.
  descriptions: ReadonlyMap<string, string>,
): SkillPickerRow[] {
  return offered.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: descriptions.get(skill.id) ?? "",
    selected: chosen?.has(skill.id) ?? false,
  }))
}

// No choice at all and a choice of nothing are different requests: the first
// leaves the project's own defaults alone, the second says this turn runs with
// no skills. The label has to tell them apart or the person cannot see which
// one they are about to send.
export function skillSelectionLabel(chosen: ReadonlySet<string> | undefined): string {
  if (!chosen) return "Project default"
  if (chosen.size === 0) return "No skills"
  return `${chosen.size} selected`
}

// A skill that has left the catalog is the whole reason this refuses rather
// than sends. Dropping it would turn a request for three skills into a request
// for two, which the daemon would accept without complaint.
export function missingSkillProblem(missing: readonly string[]): string | undefined {
  if (missing.length === 0) return undefined
  return missing.length === 1
    ? `${missing[0]} is no longer offered. Choose again before sending.`
    : `${missing.join(", ")} are no longer offered. Choose again before sending.`
}

const refusalReasons: Record<TurnSkillSelectionRefusal["reason"], string> = {
  "not-enabled": "is not enabled for this project",
  unavailable: "is no longer available",
  "review-changed": "changed since it was reviewed",
  policy: "is not allowed for this turn",
}

export function refusalMessage(refusal: TurnSkillSelectionRefusal): string {
  return `${refusal.skillId} ${refusalReasons[refusal.reason]}. Nothing was sent.`
}
