import type {
  SkillInventoryEntry,
  SkillInventorySource,
} from "@getdomovoi/protocol"

export type SkillFleetCellState =
  | "same"
  | "different"
  | "missing"
  | "blocked"
  | "untrusted"
  | "unknown"
  | "unreachable"

export type SkillFleetComparisonCell = {
  machineId: string
  machineName: string
  state: SkillFleetCellState
  skillId?: string
  contentDigest?: string
}

export type SkillFleetComparisonRow = {
  key: string
  name: string
  scope: SkillInventoryEntry["scope"]
  source: SkillInventoryEntry["source"]
  machines: SkillFleetComparisonCell[]
}

function sourceMachine(source: SkillInventorySource) {
  return source.state === "available" ? source.inventory.machine : source.machine
}

function skillKey(skill: Pick<SkillInventoryEntry, "name" | "scope" | "source">): string {
  return `${skill.name}\u0000${skill.scope}\u0000${skill.source}`
}

function fingerprint(skill: SkillInventoryEntry): string {
  return JSON.stringify([
    skill.contentDigest,
    skill.manifest.version,
    [...skill.manifest.capabilities].sort(),
  ])
}

function securityState(skill: SkillInventoryEntry): "blocked" | "untrusted" | undefined {
  if (skill.trust.state === "blocked") return "blocked"
  if (skill.trust.state === "untrusted") return "untrusted"
  return undefined
}

export function compareSkillInventories(
  supplied: readonly SkillInventorySource[],
): SkillFleetComparisonRow[] {
  const sources = [...supplied].sort((left, right) => {
    const leftMachine = sourceMachine(left)
    const rightMachine = sourceMachine(right)
    return leftMachine.name.localeCompare(rightMachine.name)
      || leftMachine.id.localeCompare(rightMachine.id)
  })
  const availableSkills = sources.flatMap((source) => (
    source.state === "available" ? source.inventory.skills : []
  ))
  const identities = new Map<string, SkillInventoryEntry>()
  for (const skill of [...availableSkills].sort((left, right) => (
    skillKey(left).localeCompare(skillKey(right)) || left.id.localeCompare(right.id)
  ))) {
    if (!identities.has(skillKey(skill))) identities.set(skillKey(skill), skill)
  }

  return [...identities.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
    ([key, reference]) => ({
      key,
      name: reference.name,
      scope: reference.scope,
      source: reference.source,
      machines: sources.map((source): SkillFleetComparisonCell => {
        const machine = sourceMachine(source)
        const base = { machineId: machine.id, machineName: machine.name }
        if (source.state !== "available") return { ...base, state: source.state }
        const candidate = [...source.inventory.skills]
          .sort((left, right) => left.id.localeCompare(right.id))
          .find((skill) => skillKey(skill) === key)
        if (!candidate) return { ...base, state: "missing" }
        return {
          ...base,
          state: securityState(candidate)
            ?? (fingerprint(candidate) === fingerprint(reference) ? "same" : "different"),
          skillId: candidate.id,
          contentDigest: candidate.contentDigest,
        }
      }),
    }),
  )
}
