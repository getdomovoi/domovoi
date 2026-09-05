import {
  maximumProviderPromptCodeUnits,
  providerPromptDeliverySchema,
  type ProviderPromptAnnotationDelivery,
  type ProviderPromptDelivery,
  type ProviderPromptHandoffDelivery,
  type ProviderPromptSkillDelivery,
  type TurnSkillSelection,
  type WorkingPlan,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentCapabilities, AgentVisualContext } from "./agents.js"
import type { AnnotationVisualContextReader } from "./annotation-visual-context.js"
import {
  prepareAnnotationContext,
  renderAnnotationContext,
} from "./annotation-context.js"
import { prepareAnnotationVisuals } from "./annotation-visual-turn.js"
import {
  handoffInclusion,
  prepareHandoffContext,
  renderHandoffContext,
  type HandoffInclusion,
} from "./handoff-context.js"
import {
  prepareTurnSkillContext,
  renderProjectSkillContext,
} from "./skill-context.js"
import type { SkillCatalog } from "./skills.js"
import { agentPromptWithWorkingPlan } from "./working-plan.js"

export type ProviderPromptInput = {
  snapshot: WorkspaceSnapshot
  sessionId: string
  userPrompt: string
  workingPlan?: WorkingPlan
  capabilities: AgentCapabilities | undefined
  annotationVisualContext: AnnotationVisualContextReader
  skillCatalog: SkillCatalog
  requireTrustedSkills: boolean
  skillSelection?: TurnSkillSelection
  budgetCodeUnits?: number
}

export type ComposedProviderPrompt = {
  prompt: string
  visualContexts: AgentVisualContext[]
  providerPromptDelivery: ProviderPromptDelivery
}

export class PromptCompositionLimitError extends Error {}

export function validateProviderPromptBudget(budgetCodeUnits: number): void {
  if (
    !Number.isSafeInteger(budgetCodeUnits)
    || budgetCodeUnits < 1
    || budgetCodeUnits > maximumProviderPromptCodeUnits
  ) {
    throw new RangeError(
      `Provider prompt budget must be an integer from 1 through ${maximumProviderPromptCodeUnits} UTF-16 code units`,
    )
  }
}

export const providerPromptPrecedence = [
  "skills",
  "annotations",
  "working-plan",
  "provider-handoff",
  "user-request",
] as const

type ProviderPromptSection = (typeof providerPromptPrecedence)[number]
type PromptSectionRetention = "required" | "elastic"

export const elasticPromptDropOrder = [
  "skills",
  "annotations",
  "handoff-history",
  "handoff-annotations",
  "handoff-artifacts",
] as const

type PromptDropStep = (typeof elasticPromptDropOrder)[number]

function promptSectionRetention(skillRetention: PromptSectionRetention): Record<
  ProviderPromptSection,
  PromptSectionRetention
> {
  return {
    skills: skillRetention,
    annotations: "elastic",
    "working-plan": "required",
    "provider-handoff": "required",
    "user-request": "required",
  }
}

function countSkillOmissions(delivery: ProviderPromptSkillDelivery): number {
  return Object.values(delivery.omitted)
    .reduce((count, skillIds) => count + skillIds.length, 0)
}

function contextDeliveryMarker(
  prompt: string,
  handoff: ProviderPromptHandoffDelivery,
  annotations: ProviderPromptAnnotationDelivery,
  skills: ProviderPromptSkillDelivery,
): string {
  const handoffOmissions = handoff.status === "delivered"
    ? handoff.omitted.threadItems + handoff.omitted.artifacts + handoff.omitted.annotations
    : 0
  const annotationOmissions = annotations.omitted.budget + annotations.omitted.limit
  const skillOmissions = countSkillOmissions(skills)
  const truncatedSkillCount = skills.delivered.filter((skill) => skill.contentTruncated).length
  if (
    handoffOmissions === 0
    && annotationOmissions === 0
    && skillOmissions === 0
    && truncatedSkillCount === 0
  ) return prompt

  const summary = {
    ...(handoffOmissions > 0 && handoff.status === "delivered"
      ? { handoff: handoff.omitted }
      : {}),
    ...(annotationOmissions > 0 ? { annotations: annotations.omitted } : {}),
    ...(skillOmissions > 0 || truncatedSkillCount > 0
      ? {
          skills: {
            omitted: Object.fromEntries(
              Object.entries(skills.omitted)
                .map(([reason, skillIds]) => [reason, skillIds.length] as const)
                .filter(([, count]) => count > 0),
            ),
            ...(truncatedSkillCount > 0 ? { contentTruncated: truncatedSkillCount } : {}),
          },
        }
      : {}),
  }
  const context = JSON.stringify(summary).replaceAll("<", "\\u003c")
  return [
    "Domovoi omitted or shortened supporting session context before this turn. Treat the delivered context as incomplete; do not assume omitted items were absent from the session.",
    "<domovoi_context_delivery>",
    context,
    "</domovoi_context_delivery>",
    "",
    prompt,
  ].join("\n")
}

function requiredContextError(
  input: ProviderPromptInput,
  handoff: ProviderPromptHandoffDelivery,
  budgetCodeUnits: number,
): PromptCompositionLimitError {
  const required = [
    "user request",
    ...(input.workingPlan ? ["working plan"] : []),
    ...(handoff.status === "delivered" ? ["provider handoff"] : []),
    ...(input.skillSelection?.skills.length ? ["explicitly selected skills"] : []),
  ]
  const remedies = [
    "Shorten the request",
    ...(input.workingPlan ? ["edit the working plan"] : []),
    ...(required.includes("provider handoff") ? ["start a fresh session"] : []),
    ...(input.skillSelection?.skills.length ? ["remove one or more selected skills"] : []),
  ]
  return new PromptCompositionLimitError(
    `Cannot send this turn: required ${required.join(" and ")} exceed the ${budgetCodeUnits} UTF-16 code units Domovoi payload limit. ${remedies.join(", ")} and try again.`,
  )
}

/**
 * Compose provider context from lowest to highest precedence. The final
 * outer-to-inner order is skills, annotations, working plan, handoff, user.
 * An omission marker, when needed, sits outside those semantic sections.
 *
 * This text goes to the provider the person selected, so composition does not
 * redact it. Redaction belongs at durable persistence and logging boundaries;
 * changing provider-bound text here would change the person's request.
 */
export async function composeProviderPrompt(
  input: ProviderPromptInput,
): Promise<ComposedProviderPrompt> {
  const budgetCodeUnits = input.budgetCodeUnits ?? maximumProviderPromptCodeUnits
  validateProviderPromptBudget(budgetCodeUnits)
  const handoff = prepareHandoffContext(input.snapshot, input.sessionId)
  const renderRequired = (inclusion: HandoffInclusion) => {
    const handoffTurn = renderHandoffContext(handoff, inclusion, input.userPrompt)
    return {
      prompt: input.workingPlan
        ? agentPromptWithWorkingPlan(input.workingPlan, handoffTurn.prompt)
        : handoffTurn.prompt,
      delivery: handoffTurn.delivery,
    }
  }
  const floor = renderRequired({ history: 0, annotations: 0, artifacts: 0 })
  if (floor.prompt.length > budgetCodeUnits) {
    throw requiredContextError(input, floor.delivery, budgetCodeUnits)
  }
  const annotationVisuals = await prepareAnnotationVisuals(
    input.snapshot,
    input.sessionId,
    input.capabilities,
    input.annotationVisualContext,
  )
  const annotations = prepareAnnotationContext(
    input.snapshot,
    input.sessionId,
    annotationVisuals.deliveries,
  )
  const skills = await prepareTurnSkillContext(
    input.skillCatalog,
    input.snapshot,
    input.skillSelection,
    { requireTrusted: input.requireTrustedSkills },
  )
  const retention = promptSectionRetention(skills.retention)
  let includedSkills = skills.deliverable.length
  let includedAnnotations = annotations.candidates.length
  const includedHandoff = handoffInclusion(handoff)
  const droppers: Record<PromptDropStep, () => boolean> = {
    skills: () => {
      if (retention.skills !== "elastic") return false
      if (includedSkills === 0) return false
      includedSkills -= 1
      return true
    },
    annotations: () => {
      if (retention.annotations !== "elastic") return false
      if (includedAnnotations === 0) return false
      includedAnnotations -= 1
      return true
    },
    "handoff-history": () => {
      if (includedHandoff.history === 0) return false
      includedHandoff.history -= 1
      return true
    },
    "handoff-annotations": () => {
      if (includedHandoff.annotations === 0) return false
      includedHandoff.annotations -= 1
      return true
    },
    "handoff-artifacts": () => {
      if (includedHandoff.artifacts === 0) return false
      includedHandoff.artifacts -= 1
      return true
    },
  }

  while (true) {
    const requiredTurn = renderRequired(includedHandoff)
    const annotationTurn = renderAnnotationContext(
      annotations,
      includedAnnotations,
      requiredTurn.prompt,
    )
    const skillTurn = renderProjectSkillContext(
      skills,
      includedSkills,
      annotationTurn.prompt,
    )
    const prompt = contextDeliveryMarker(
      skillTurn.prompt,
      requiredTurn.delivery,
      annotationTurn.delivery,
      skillTurn.delivery,
    )
    if (prompt.length <= budgetCodeUnits) {
      const providerPromptDelivery = providerPromptDeliverySchema.parse({
        version: 1,
        budget: {
          unit: "utf16-code-units",
          limit: budgetCodeUnits,
          used: prompt.length,
        },
        handoff: requiredTurn.delivery,
        workingPlan: input.workingPlan
          ? {
              status: "delivered",
              revision: input.workingPlan.revision,
              structureRevision: input.workingPlan.structureRevision,
            }
          : { status: "not-required" },
        annotations: annotationTurn.delivery,
        skills: skillTurn.delivery,
      })
      const deliveredAnnotationIds = new Set(annotationTurn.delivery.deliveredIds)
      return {
        prompt,
        visualContexts: annotationVisuals.visualContexts.filter(
          (context) => deliveredAnnotationIds.has(context.annotationId),
        ),
        providerPromptDelivery,
      }
    }

    // Retention order is separate from semantic prompt precedence.
    const dropped = elasticPromptDropOrder.some((step) => droppers[step]())
    if (!dropped) throw requiredContextError(input, requiredTurn.delivery, budgetCodeUnits)
  }
}
