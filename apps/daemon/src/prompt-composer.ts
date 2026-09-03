import type { WorkingPlan, WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentCapabilities, AgentVisualContext } from "./agents.js"
import type { AnnotationVisualContextReader } from "./annotation-visual-context.js"
import { prepareAnnotationTurn } from "./annotation-visual-turn.js"
import { agentPromptWithHandoff } from "./handoff-context.js"
import { agentPromptWithSkills } from "./skill-context.js"
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
}

export type ComposedProviderPrompt = {
  prompt: string
  visualContexts: AgentVisualContext[]
}

/**
 * Compose provider context from lowest to highest precedence. The final
 * outer-to-inner order is skills, annotations, working plan, handoff, user.
 *
 * This text goes to the provider the person selected, so composition does not
 * redact it. Redaction belongs at durable persistence and logging boundaries;
 * changing provider-bound text here would change the person's request.
 */
export async function composeProviderPrompt(
  input: ProviderPromptInput,
): Promise<ComposedProviderPrompt> {
  const handoffPrompt = agentPromptWithHandoff(
    input.snapshot,
    input.sessionId,
    input.userPrompt,
  )
  const planPrompt = input.workingPlan
    ? agentPromptWithWorkingPlan(input.workingPlan, handoffPrompt)
    : handoffPrompt
  const annotationTurn = await prepareAnnotationTurn(
    input.snapshot,
    input.sessionId,
    planPrompt,
    input.capabilities,
    input.annotationVisualContext,
  )
  const prompt = await agentPromptWithSkills(
    input.skillCatalog,
    input.snapshot,
    annotationTurn.prompt,
    { requireTrusted: input.requireTrustedSkills },
  )
  return { prompt, visualContexts: annotationTurn.visualContexts }
}
