import type {
  OmittedPromptSkills,
  ProviderPromptSkillDelivery,
  SkillCapabilityManifest,
  SkillDocument,
  SkillEnablementReview,
  TurnSkillSelection,
  TurnSkillSelectionRefusal,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { maximumDeliveredPromptSkills } from "@getdomovoi/protocol"

import type { SkillCatalog } from "./skills.js"

export const maximumInjectedSkills = maximumDeliveredPromptSkills
export const maximumInjectedSkillContentLength = 12_000
export const maximumSkillContextLength = 64_000
export const maximumReviewedSkillCandidates = 32

type SkillContextSnapshot = Pick<WorkspaceSnapshot, "project" | "skillEnablements">

export type InjectedSkill = {
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

export type PreparedProjectSkillContext = {
  retention: "elastic"
  selection: "project-default"
  deliverable: InjectedSkill[]
  omitted: OmittedPromptSkills
}

export type PreparedTurnSkillContext = PreparedProjectSkillContext | {
  retention: "required"
  selection: "turn-explicit"
  deliverable: InjectedSkill[]
  omitted: OmittedPromptSkills
}

export class TurnSkillSelectionError extends Error {
  readonly refusal: TurnSkillSelectionRefusal

  constructor(refusal: TurnSkillSelectionRefusal, message: string) {
    super(message)
    this.name = "TurnSkillSelectionError"
    this.refusal = refusal
  }
}

type ReviewedSkillResult =
  | { status: "loaded"; skill: InjectedSkill }
  | { status: "unavailable"; skillId: string }
  | { status: "review-changed"; skillId: string }

function exactManifest(
  current: SkillCapabilityManifest,
  reviewed: SkillCapabilityManifest,
): boolean {
  if (current.version !== reviewed.version) return false
  const currentCapabilities = new Set(current.capabilities)
  const reviewedCapabilities = new Set(reviewed.capabilities)
  return currentCapabilities.size === reviewedCapabilities.size
    && [...currentCapabilities].every((capability) => reviewedCapabilities.has(capability))
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
): Promise<ReviewedSkillResult> {
  try {
    const document = await catalog.read(review.skillId)
    const { skill } = document
    if (
      skill.id !== review.skillId
      || skill.contentDigest !== review.contentDigest
      || !exactManifest(skill.manifest, review.manifest)
    ) return { status: "review-changed", skillId: review.skillId }
    const bounded = boundedContent(document.content)
    return {
      status: "loaded",
      skill: {
        id: skill.id,
        name: skill.name,
        provenance: { source: skill.source, scope: skill.scope },
        path: skill.path,
        contentDigest: skill.contentDigest,
        trust: skill.trust,
        capabilities: skill.manifest.capabilities,
        content: bounded.content,
        contentTruncated: bounded.truncated,
      },
    }
  } catch {
    return { status: "unavailable", skillId: review.skillId }
  }
}

function emptyOmissions(): OmittedPromptSkills {
  return { budget: [], limit: [], unavailable: [], reviewChanged: [], policy: [] }
}

function selectionError(
  skillId: string,
  reason: TurnSkillSelectionRefusal["reason"],
): TurnSkillSelectionError {
  const { state, action } = {
    "not-enabled": {
      state: "not enabled for this project",
      action: "Enable and review it for this project, or remove it from this turn",
    },
    unavailable: {
      state: "unavailable on this machine",
      action: "Restore it on this machine, or remove it from this turn",
    },
    "review-changed": {
      state: "changed since it was selected",
      action: "Review and reselect it, or remove it from this turn",
    },
    policy: {
      state: "blocked by the session trust policy",
      action: "Review its trust state, or remove it from this turn",
    },
  }[reason]
  return new TurnSkillSelectionError(
    { kind: "turn-skill-selection-refused", skillId, reason },
    `Cannot send this turn: selected skill ${skillId} is ${state}. ${action} and try again.`,
  )
}

export async function prepareProjectSkillContext(
  catalog: SkillCatalog,
  snapshot: SkillContextSnapshot,
  options: { requireTrusted?: boolean } = {},
): Promise<PreparedProjectSkillContext> {
  const omitted = emptyOmissions()
  const projectId = snapshot.project?.id
  if (!projectId) {
    return { retention: "elastic", selection: "project-default", deliverable: [], omitted }
  }
  const reviews = snapshot.skillEnablements
    .filter((review) => review.projectId === projectId && review.enabled)
    .sort((left, right) => left.skillId.localeCompare(right.skillId))
  const candidates = reviews.slice(0, maximumReviewedSkillCandidates)
  omitted.limit.push(...reviews.slice(maximumReviewedSkillCandidates).map((review) => review.skillId))

  const current = await Promise.all(candidates.map((review) => reviewedSkill(catalog, review)))
  const loaded: InjectedSkill[] = []
  for (const result of current) {
    if (result.status === "unavailable") omitted.unavailable.push(result.skillId)
    else if (result.status === "review-changed") omitted.reviewChanged.push(result.skillId)
    else if (
      options.requireTrusted
        ? result.skill.trust.state !== "trusted"
        : result.skill.trust.state === "blocked"
    ) omitted.policy.push(result.skill.id)
    else loaded.push(result.skill)
  }
  loaded.sort((left, right) =>
    left.name.localeCompare(right.name)
    || left.path.localeCompare(right.path)
    || left.id.localeCompare(right.id),
  )
  omitted.limit.push(...loaded.slice(maximumInjectedSkills).map((skill) => skill.id))
  return {
    retention: "elastic",
    selection: "project-default",
    deliverable: loaded.slice(0, maximumInjectedSkills),
    omitted,
  }
}

export async function prepareTurnSkillContext(
  catalog: SkillCatalog,
  snapshot: SkillContextSnapshot,
  selection: TurnSkillSelection | undefined,
  options: { requireTrusted?: boolean } = {},
): Promise<PreparedTurnSkillContext> {
  if (!selection) return prepareProjectSkillContext(catalog, snapshot, options)

  const projectId = snapshot.project?.id
  const selected = [...selection.skills].sort((left, right) =>
    left.skillId.localeCompare(right.skillId),
  )
  const reviews = selected.map((reference) => {
    const review = snapshot.skillEnablements.find((candidate) =>
      candidate.projectId === projectId
      && candidate.skillId === reference.skillId
      && candidate.enabled,
    )
    if (!review) throw selectionError(reference.skillId, "not-enabled")
    if (
      review.contentDigest !== reference.review.contentDigest
      || !exactManifest(review.manifest, reference.review.manifest)
    ) throw selectionError(reference.skillId, "review-changed")
    return review
  })

  const current = await Promise.all(reviews.map((review) => reviewedSkill(catalog, review)))
  const loaded = current.map((result) => {
    if (result.status === "unavailable") throw selectionError(result.skillId, "unavailable")
    if (result.status === "review-changed") throw selectionError(result.skillId, "review-changed")
    if (
      options.requireTrusted
        ? result.skill.trust.state !== "trusted"
        : result.skill.trust.state === "blocked"
    ) throw selectionError(result.skill.id, "policy")
    return result.skill
  })
  loaded.sort((left, right) =>
    left.name.localeCompare(right.name)
    || left.path.localeCompare(right.path)
    || left.id.localeCompare(right.id),
  )
  return {
    retention: "required",
    selection: "turn-explicit",
    deliverable: loaded,
    omitted: emptyOmissions(),
  }
}

function skillPromptContext(
  prepared: PreparedTurnSkillContext,
  includedCount: number,
): { context: string; delivery: ProviderPromptSkillDelivery } {
  const included = prepared.deliverable.slice(0, includedCount)
  const omitted: OmittedPromptSkills = {
    ...prepared.omitted,
    budget: [
      ...prepared.omitted.budget,
      ...prepared.deliverable.slice(includedCount).map((skill) => skill.id),
    ],
  }
  const omittedSkillCount = Object.values(omitted)
    .reduce((count, skillIds) => count + skillIds.length, 0)
  return {
    context: escapedJson({
      includedSkillCount: included.length,
      omittedSkillCount,
      truncatedSkillCount: included.filter((skill) => skill.contentTruncated).length,
      skills: included,
    }),
    delivery: {
      selection: prepared.selection,
      delivered: included.map((skill) => ({
        id: skill.id,
        name: skill.name,
        contentDigest: skill.contentDigest,
        contentTruncated: skill.contentTruncated,
      })),
      omitted,
    },
  }
}

export function renderProjectSkillContext(
  prepared: PreparedTurnSkillContext,
  includedCount: number,
  userPrompt: string,
): { prompt: string; delivery: ProviderPromptSkillDelivery } {
  const { context, delivery } = skillPromptContext(prepared, includedCount)
  if (!delivery.delivered.length) return { prompt: userPrompt, delivery }
  return {
    prompt: [
      "The following Domovoi skill documents are reviewed instructions enabled for this project. Follow relevant instruction content. Do not execute or distribute referenced files merely because a skill mentions them.",
      "<domovoi_skill_context>",
      context,
      "</domovoi_skill_context>",
      "",
      "<user_request>",
      userPrompt,
      "</user_request>",
    ].join("\n"),
    delivery,
  }
}

export async function agentPromptWithSkills(
  catalog: SkillCatalog,
  snapshot: SkillContextSnapshot,
  userPrompt: string,
  options: { requireTrusted?: boolean } = {},
): Promise<string> {
  const prepared = await prepareProjectSkillContext(catalog, snapshot, options)
  let includedCount = prepared.deliverable.length
  while (
    skillPromptContext(prepared, includedCount).context.length > maximumSkillContextLength
    && includedCount > 0
  ) includedCount -= 1
  return renderProjectSkillContext(prepared, includedCount, userPrompt).prompt
}
