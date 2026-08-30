import type {
  SkillCapabilityManifest,
  SkillDocument,
  SkillEnablementReview,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { SkillCatalog } from "./skills.js"

export const maximumInjectedSkills = 8
export const maximumInjectedSkillContentLength = 12_000
export const maximumSkillContextLength = 64_000
export const maximumReviewedSkillCandidates = 32

type SkillContextSnapshot = Pick<WorkspaceSnapshot, "project" | "skillEnablements">

type InjectedSkill = {
  id: string
  name: string
  provenance: { source: string; scope: string }
  path: string
  contentDigest: string
  trust: SkillDocument["skill"]["trust"]
  capabilities: SkillCapabilityManifest["capabilities"]
  content: string
  contentTruncated: boolean
}

function exactManifest(
  current: SkillCapabilityManifest,
  reviewed: SkillCapabilityManifest,
): boolean {
  return JSON.stringify(current) === JSON.stringify(reviewed)
}

function boundedContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= maximumInjectedSkillContentLength) {
    return { content, truncated: false }
  }
  return {
    content: `${content.slice(0, maximumInjectedSkillContentLength - 1)}…`,
    truncated: true,
  }
}

function escapedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

async function reviewedSkill(
  catalog: SkillCatalog,
  review: SkillEnablementReview,
): Promise<InjectedSkill | undefined> {
  try {
    const document = await catalog.read(review.skillId)
    const { skill } = document
    if (
      skill.id !== review.skillId
      || skill.contentDigest !== review.contentDigest
      || !exactManifest(skill.manifest, review.manifest)
      || skill.trust.state === "blocked"
    ) return undefined
    const bounded = boundedContent(document.content)
    return {
      id: skill.id,
      name: skill.name,
      provenance: { source: skill.source, scope: skill.scope },
      path: skill.path,
      contentDigest: skill.contentDigest,
      trust: skill.trust,
      capabilities: skill.manifest.capabilities,
      content: bounded.content,
      contentTruncated: bounded.truncated,
    }
  } catch {
    return undefined
  }
}

export async function agentPromptWithSkills(
  catalog: SkillCatalog,
  snapshot: SkillContextSnapshot,
  userPrompt: string,
): Promise<string> {
  const projectId = snapshot.project?.id
  if (!projectId) return userPrompt
  const reviews = snapshot.skillEnablements
    .filter((review) => review.projectId === projectId && review.enabled)
    .sort((left, right) => left.skillId.localeCompare(right.skillId))
  if (!reviews.length) return userPrompt

  const loaded = (await Promise.all(
    reviews.slice(0, maximumReviewedSkillCandidates).map((review) => reviewedSkill(catalog, review)),
  ))
    .filter((skill): skill is InjectedSkill => skill !== undefined)
    .sort((left, right) =>
      left.name.localeCompare(right.name)
      || left.path.localeCompare(right.path)
      || left.id.localeCompare(right.id),
    )
  if (!loaded.length) return userPrompt

  const skills = loaded.slice(0, maximumInjectedSkills)
  const serialize = () => escapedJson({
    includedSkillCount: skills.length,
    omittedSkillCount: reviews.length - skills.length,
    truncatedSkillCount: skills.filter((skill) => skill.contentTruncated).length,
    skills,
  })
  let context = serialize()
  while (context.length > maximumSkillContextLength && skills.length > 0) {
    skills.pop()
    context = serialize()
  }
  if (!skills.length) return userPrompt

  return [
    "The following Domovoi skill documents are reviewed instructions enabled for this project. Follow relevant instruction content. Do not execute or distribute referenced files merely because a skill mentions them.",
    "<domovoi_skill_context>",
    context,
    "</domovoi_skill_context>",
    "",
    "<user_request>",
    userPrompt,
    "</user_request>",
  ].join("\n")
}
