import type { SkillScope, SkillSource, SkillSummary } from "@getdomovoi/protocol"

const scopeOrder: Record<SkillScope, number> = { project: 0, user: 1, system: 2 }

const sourceLabels: Record<SkillSource, string> = {
  agents: "Agents",
  claude: "Claude",
  codex: "Codex",
  domovoi: "Domovoi",
  kilo: "Kilo",
}

export type SkillGroup = {
  key: string
  label: string
  skills: SkillSummary[]
}

export function skillSourceLabel(source: SkillSource): string {
  return sourceLabels[source]
}

export function filterSkills(skills: readonly SkillSummary[], query: string): SkillSummary[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...skills]
  return skills.filter((skill) => {
    const searchable = [
      skill.name,
      skill.description,
      skill.path,
      skill.scope,
      skill.source,
      sourceLabels[skill.source],
    ].join(" ").toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
}

export function groupSkills(skills: readonly SkillSummary[]): SkillGroup[] {
  const groups = new Map<string, SkillSummary[]>()
  for (const skill of skills) {
    const key = `${skill.scope}:${skill.source}`
    const group = groups.get(key) ?? []
    group.push(skill)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, items]) => {
    const [scope, source] = key.split(":") as [SkillScope, SkillSource]
    return {
      key,
      label: `${scope.toLocaleUpperCase()} · ${sourceLabels[source].toLocaleUpperCase()}`,
      skills: items.sort((left, right) => left.name.localeCompare(right.name)),
    }
  }).sort((left, right) => {
    const [leftScope] = left.key.split(":") as [SkillScope]
    const [rightScope] = right.key.split(":") as [SkillScope]
    return scopeOrder[leftScope] - scopeOrder[rightScope] || left.label.localeCompare(right.label)
  })
}
