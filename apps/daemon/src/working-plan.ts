import { randomUUID } from "node:crypto"

import {
  maximumWorkingPlanSteps,
  maximumWorkingPlanStepTextLength,
  maximumWorkingPlanTextLength,
  planEditParamsSchema,
  planEditReceiptSchema,
  workingPlanSchema,
  type Annotation,
  type Artifact,
  type PlanEditParams,
  type PlanEditReceipt,
  type WorkingPlan,
  type WorkingPlanClientAttribution,
  type WorkingPlanStep,
  type WorkingPlanStepStatus,
  type WorkingPlanStructureStep,
} from "@getdomovoi/protocol"

import { redactDurableText } from "./secret-redaction.js"

export type WorkingPlanIdKind = "edit" | "receipt" | "step"
export type WorkingPlanIdFactory = (kind: WorkingPlanIdKind) => string

export type ProviderWorkingPlanStep = {
  text: unknown
  status: WorkingPlanStepStatus
}

export type ProviderWorkingPlanUpdate = {
  sessionId: string
  provider: string
  model: string
  providerThreadId: string
  steps: ProviderWorkingPlanStep[]
  updatedAt: string
}

export type WorkingPlanUpdateResult = {
  plan: WorkingPlan
  changed: boolean
  structureChanged: boolean
}

export type WorkingPlanProviderTarget = {
  provider: string
  model: string
  providerThreadId: string
}

export class WorkingPlanMutationError extends Error {}

const defaultIdFactory: WorkingPlanIdFactory = (kind) => `plan-${kind}-${randomUUID()}`

export function workingPlanNeedsProviderDelivery(
  plan: WorkingPlan,
  target: WorkingPlanProviderTarget,
): boolean {
  return plan.providerSync?.provider !== target.provider
    || plan.providerSync.model !== target.model
    || plan.providerSync.providerThreadId !== target.providerThreadId
    || plan.providerSync.structureRevision !== plan.structureRevision
}

export function agentPromptWithWorkingPlan(plan: WorkingPlan, userPrompt: string): string {
  const context = JSON.stringify({
    revision: plan.revision,
    structureRevision: plan.structureRevision,
    steps: plan.steps.map(({ id, text, status }) => ({ id, text, status })),
  }).replaceAll("<", "\\u003c")
  return [
    "Domovoi's working plan is canonical session state. Follow it unless the work requires replanning, and report progress through your plan mechanism.",
    "<domovoi_working_plan>",
    context,
    "</domovoi_working_plan>",
    "",
    userPrompt,
  ].join("\n")
}

export function markWorkingPlanDelivered(
  plan: WorkingPlan,
  target: WorkingPlanProviderTarget,
  deliveredAt: string,
): WorkingPlan {
  if (!workingPlanNeedsProviderDelivery(plan, target)) return plan
  return workingPlanSchema.parse({
    ...plan,
    revision: plan.revision + 1,
    providerSync: {
      ...target,
      structureRevision: plan.structureRevision,
      deliveredAt,
    },
    updatedAt: deliveredAt,
  })
}

export function updateWorkingPlanFromProvider(
  current: WorkingPlan | undefined,
  update: ProviderWorkingPlanUpdate,
  createId: WorkingPlanIdFactory = defaultIdFactory,
): WorkingPlanUpdateResult {
  if (current && current.sessionId !== update.sessionId) {
    throw new WorkingPlanMutationError("Provider plan update belongs to another session")
  }

  const normalized = boundedProviderSteps(update.steps)
  const previousByText = uniquelyIndexedByText(current?.steps ?? [])
  const incomingCounts = textCounts(normalized)
  const steps = normalized.map((step): WorkingPlanStep => {
    const prior = incomingCounts.get(step.text) === 1 ? previousByText.get(step.text) : undefined
    const blockedStatus = prior?.blocker && step.status === "completed"
      ? prior.status
      : step.status
    return {
      id: prior?.id ?? createId("step"),
      text: step.text,
      status: blockedStatus,
      ...(prior?.blocker ? { blocker: prior.blocker } : {}),
    }
  })

  if (!current) {
    const structureRevision = steps.length === 0 ? 0 : 1
    const plan = workingPlanSchema.parse({
      sessionId: update.sessionId,
      revision: 1,
      structureRevision,
      steps,
      providerSync: providerSync(update, structureRevision),
      createdAt: update.updatedAt,
      updatedAt: update.updatedAt,
    })
    return { plan, changed: true, structureChanged: true }
  }

  const structureChanged = !sameStructure(current.steps, steps)
  const structureRevision = current.structureRevision + (structureChanged ? 1 : 0)
  const progressChanged = !sameProgress(current.steps, steps)
  const nextProviderSync = providerSync(update, structureRevision)
  const syncChanged = !sameProviderSync(current.providerSync, nextProviderSync)
  const pendingEdit = structureChanged && current.pendingEdit?.status === "queued"
    ? { ...current.pendingEdit, status: "conflicted" as const }
    : current.pendingEdit
  const pendingChanged = pendingEdit?.status !== current.pendingEdit?.status
  const changed = structureChanged || progressChanged || syncChanged || pendingChanged
  if (!changed) return { plan: current, changed: false, structureChanged: false }

  const plan = workingPlanSchema.parse({
    ...current,
    revision: current.revision + 1,
    structureRevision,
    steps,
    providerSync: syncChanged ? nextProviderSync : current.providerSync,
    ...(pendingEdit ? { pendingEdit } : {}),
    updatedAt: update.updatedAt,
  })
  return { plan, changed: true, structureChanged }
}

export function syncWorkingPlanArtifact(
  artifacts: Artifact[],
  annotations: Annotation[],
  plan: WorkingPlan,
  structureChanged: boolean,
): { artifact: Artifact, changed: boolean } {
  const artifactId = `plan-${plan.sessionId}`
  const legacyPrefix = `${artifactId}-`
  const matching = artifacts.filter((artifact) =>
    artifact.sessionId === plan.sessionId
    && artifact.type === "plan"
    && (artifact.id === artifactId || artifact.id.startsWith(legacyPrefix)),
  )
  const stable = matching.find((artifact) => artifact.id === artifactId)
  if (!structureChanged && stable) return { artifact: stable, changed: false }

  const content = renderWorkingPlanMarkdown(plan.steps)
  if (matching.length === 0) {
    const artifact: Artifact = {
      id: artifactId,
      sessionId: plan.sessionId,
      title: "Working plan",
      type: "plan",
      revision: 1,
      mimeType: "text/markdown",
      content,
    }
    artifacts.push(artifact)
    return { artifact, changed: true }
  }

  const mergedIds = new Set(matching.map((artifact) => artifact.id))
  const artifact = stable ?? matching[0]!
  artifact.id = artifactId
  artifact.title = "Working plan"
  artifact.type = "plan"
  artifact.revision = matching.reduce((total, candidate) => total + candidate.revision, 0) + 1
  artifact.mimeType = "text/markdown"
  artifact.content = content
  delete artifact.path
  delete artifact.variant

  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const candidate = artifacts[index]!
    if (candidate !== artifact && matching.includes(candidate)) artifacts.splice(index, 1)
  }
  for (const annotation of annotations) {
    if (annotation.sessionId === plan.sessionId && mergedIds.has(annotation.artifactId)) {
      annotation.artifactId = artifactId
    }
  }
  return { artifact, changed: true }
}

export function submitWorkingPlanEdit(
  current: WorkingPlan | undefined,
  input: PlanEditParams,
  attribution: WorkingPlanClientAttribution,
  turnPinned: boolean,
  updatedAt: string,
  createId: WorkingPlanIdFactory = defaultIdFactory,
): { plan: WorkingPlan, receipt: PlanEditReceipt, structureChanged: boolean } {
  const params = planEditParamsSchema.parse(input)
  if (params.client !== attribution.client) {
    throw new WorkingPlanMutationError("Plan edit client does not match the authenticated client")
  }
  if (current && current.sessionId !== params.sessionId) {
    throw new WorkingPlanMutationError("Plan edit belongs to another session")
  }
  if (current?.pendingEdit) {
    if (params.replacesPendingEditId !== current.pendingEdit.id) {
      throw new WorkingPlanMutationError("A pending plan edit requires explicit replacement")
    }
  } else if (params.replacesPendingEditId !== undefined) {
    throw new WorkingPlanMutationError("The pending plan edit no longer exists")
  }

  const currentSteps = current?.steps ?? []
  const structureRevision = current?.structureRevision ?? 0
  if (params.basedOnStructureRevision > structureRevision) {
    throw new WorkingPlanMutationError("Plan edit revision is ahead of the current plan")
  }
  const baseSteps = boundedStructureSteps(params.baseSteps)
  if (
    params.basedOnStructureRevision === structureRevision
    && !sameStructure(baseSteps, currentSteps)
  ) {
    throw new WorkingPlanMutationError("Plan edit base does not match the current plan")
  }

  const editId = createId("edit")
  const receiptId = createId("receipt")
  const allowedIds = new Set(baseSteps.map(({ id }) => id))
  if (current?.pendingEdit && params.replacesPendingEditId === current.pendingEdit.id) {
    for (const step of current.pendingEdit.draftSteps) allowedIds.add(step.id)
  }
  const draftSteps = boundedDraftSteps(params.draftSteps, allowedIds, createId)
  const stale = params.basedOnStructureRevision < structureRevision
  let plan: WorkingPlan
  let disposition: PlanEditReceipt["disposition"]
  let structureChanged = false

  if (stale || turnPinned) {
    disposition = stale ? "conflicted" : "queued"
    plan = workingPlanSchema.parse({
      ...(current ?? {
        sessionId: params.sessionId,
        revision: 0,
        structureRevision: 0,
        steps: [],
        createdAt: updatedAt,
      }),
      revision: (current?.revision ?? 0) + 1,
      pendingEdit: {
        id: editId,
        basedOnStructureRevision: params.basedOnStructureRevision,
        baseSteps,
        draftSteps,
        status: disposition,
        submittedAt: updatedAt,
        submittedBy: attribution,
      },
      updatedAt,
    })
  } else {
    const nextSteps = applyDraftStructure(currentSteps, draftSteps)
    structureChanged = !sameStructure(currentSteps, nextSteps)
    const changed = structureChanged || current?.pendingEdit !== undefined || current === undefined
    plan = workingPlanSchema.parse({
      ...(current ?? {
        sessionId: params.sessionId,
        revision: 0,
        structureRevision: 0,
        steps: [],
        createdAt: updatedAt,
      }),
      revision: (current?.revision ?? 0) + (changed ? 1 : 0),
      structureRevision: structureRevision + (structureChanged ? 1 : 0),
      steps: nextSteps,
      pendingEdit: undefined,
      updatedAt: changed ? updatedAt : current!.updatedAt,
    })
    disposition = "applied"
  }

  const receipt = planEditReceiptSchema.parse({
    id: receiptId,
    editId,
    sessionId: params.sessionId,
    disposition,
    basedOnStructureRevision: params.basedOnStructureRevision,
    planRevision: plan.revision,
    structureRevision: plan.structureRevision,
    ...attribution,
    createdAt: updatedAt,
  })
  return { plan, receipt, structureChanged }
}

export function finalizePendingWorkingPlanEdit(
  current: WorkingPlan,
  updatedAt: string,
): { plan: WorkingPlan, disposition: "applied" | "conflicted" | undefined, structureChanged: boolean } {
  const pending = current.pendingEdit
  if (!pending) return { plan: current, disposition: undefined, structureChanged: false }
  if (
    pending.status === "conflicted"
    || pending.basedOnStructureRevision !== current.structureRevision
    || !sameStructure(pending.baseSteps, current.steps)
  ) {
    if (pending.status === "conflicted") {
      return { plan: current, disposition: "conflicted", structureChanged: false }
    }
    const plan = workingPlanSchema.parse({
      ...current,
      revision: current.revision + 1,
      pendingEdit: { ...pending, status: "conflicted" },
      updatedAt,
    })
    return { plan, disposition: "conflicted", structureChanged: false }
  }

  const steps = applyDraftStructure(current.steps, pending.draftSteps)
  const structureChanged = !sameStructure(current.steps, steps)
  const plan = workingPlanSchema.parse({
    ...current,
    revision: current.revision + 1,
    structureRevision: current.structureRevision + (structureChanged ? 1 : 0),
    steps,
    pendingEdit: undefined,
    updatedAt,
  })
  return { plan, disposition: "applied", structureChanged }
}

export function discardPendingWorkingPlanEdit(
  current: WorkingPlan,
  editId: string,
  attribution: WorkingPlanClientAttribution,
  updatedAt: string,
  createId: WorkingPlanIdFactory = defaultIdFactory,
): { plan: WorkingPlan, receipt: PlanEditReceipt } {
  const pending = current.pendingEdit
  if (!pending || pending.id !== editId) {
    throw new WorkingPlanMutationError("Pending plan edit does not exist")
  }
  const plan = workingPlanSchema.parse({
    ...current,
    revision: current.revision + 1,
    pendingEdit: undefined,
    updatedAt,
  })
  const receipt = planEditReceiptSchema.parse({
    id: createId("receipt"),
    editId,
    sessionId: current.sessionId,
    disposition: "discarded",
    basedOnStructureRevision: pending.basedOnStructureRevision,
    planRevision: plan.revision,
    structureRevision: plan.structureRevision,
    ...attribution,
    createdAt: updatedAt,
  })
  return { plan, receipt }
}

export function blockWorkingPlanForApproval(
  plans: WorkingPlan[],
  sessionId: string,
  approvalId: string,
  updatedAt: string,
): { plans: WorkingPlan[], changed: boolean } {
  const planIndex = plans.findIndex((plan) => plan.sessionId === sessionId)
  if (planIndex === -1) return { plans, changed: false }
  const plan = plans[planIndex]!
  const activeIndexes = plan.steps.flatMap((step, index) => (
    step.status === "in-progress" ? [index] : []
  ))
  if (activeIndexes.length !== 1) return { plans, changed: false }
  const stepIndex = activeIndexes[0]!
  if (plan.steps[stepIndex]!.blocker) return { plans, changed: false }

  const steps = [...plan.steps]
  steps[stepIndex] = {
    ...steps[stepIndex]!,
    blocker: { kind: "approval", approvalId },
  }
  const next = [...plans]
  next[planIndex] = workingPlanSchema.parse({
    ...plan,
    revision: plan.revision + 1,
    steps,
    updatedAt,
  })
  return { plans: next, changed: true }
}

export function clearWorkingPlanApprovalBlockers(
  plans: WorkingPlan[],
  approvalIds: ReadonlySet<string>,
  updatedAt: string,
): { plans: WorkingPlan[], changedSessionIds: string[] } {
  const changedSessionIds: string[] = []
  const next = plans.map((plan) => {
    let changed = false
    const steps = plan.steps.map((step): WorkingPlanStep => {
      if (!step.blocker || !approvalIds.has(step.blocker.approvalId)) return step
      changed = true
      const { blocker: _blocker, ...unblocked } = step
      return unblocked
    })
    if (!changed) return plan
    changedSessionIds.push(plan.sessionId)
    return workingPlanSchema.parse({
      ...plan,
      revision: plan.revision + 1,
      steps,
      updatedAt,
    })
  })
  return { plans: next, changedSessionIds }
}

function providerSync(update: ProviderWorkingPlanUpdate, structureRevision: number) {
  return {
    provider: update.provider,
    model: update.model,
    providerThreadId: update.providerThreadId,
    structureRevision,
    deliveredAt: update.updatedAt,
  }
}

function sameProviderSync(
  current: WorkingPlan["providerSync"],
  next: NonNullable<WorkingPlan["providerSync"]>,
): boolean {
  return current?.provider === next.provider
    && current.model === next.model
    && current.providerThreadId === next.providerThreadId
    && current.structureRevision === next.structureRevision
}

function uniquelyIndexedByText(steps: WorkingPlanStep[]): Map<string, WorkingPlanStep> {
  const counts = textCounts(steps)
  return new Map(steps.flatMap((step) => counts.get(step.text) === 1 ? [[step.text, step]] : []))
}

function textCounts(steps: ReadonlyArray<{ text: string }>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const step of steps) counts.set(step.text, (counts.get(step.text) ?? 0) + 1)
  return counts
}

function boundedProviderSteps(steps: ProviderWorkingPlanStep[]): Array<{
  text: string
  status: WorkingPlanStepStatus
}> {
  const bounded: Array<{ text: string, status: WorkingPlanStepStatus }> = []
  let remaining = maximumWorkingPlanTextLength
  for (const step of steps.slice(0, maximumWorkingPlanSteps)) {
    if (remaining <= 0) break
    const text = boundedWorkingPlanText(step.text, Math.min(
      maximumWorkingPlanStepTextLength,
      remaining,
    ))
    if (!text) continue
    bounded.push({ text, status: step.status })
    remaining -= text.length
  }
  return bounded
}

function boundedStructureSteps(steps: WorkingPlanStructureStep[]): WorkingPlanStructureStep[] {
  return steps.map((step) => ({
    id: step.id,
    text: boundedWorkingPlanText(step.text, maximumWorkingPlanStepTextLength)
      ?? "[Empty plan step]",
  }))
}

function boundedDraftSteps(
  steps: PlanEditParams["draftSteps"],
  allowedIds: ReadonlySet<string>,
  createId: WorkingPlanIdFactory,
): WorkingPlanStructureStep[] {
  return steps.map((step) => {
    if (step.id !== undefined && !allowedIds.has(step.id)) {
      throw new WorkingPlanMutationError("Plan draft contains an unknown step id")
    }
    return {
      id: step.id ?? createId("step"),
      text: boundedWorkingPlanText(step.text, maximumWorkingPlanStepTextLength)
        ?? "[Empty plan step]",
    }
  })
}

function boundedWorkingPlanText(value: unknown, maximumLength: number): string | undefined {
  if (maximumLength <= 0) return undefined
  const redacted = redactDurableText(value).value.trim()
  if (!redacted) return undefined
  if (redacted.length <= maximumLength) return redacted
  if (maximumLength === 1) return "…"
  return `${redacted.slice(0, maximumLength - 1)}…`
}

function sameStructure(
  left: ReadonlyArray<{ id: string, text: string }>,
  right: ReadonlyArray<{ id: string, text: string }>,
): boolean {
  return left.length === right.length && left.every((step, index) => {
    const candidate = right[index]
    return candidate?.id === step.id && candidate.text === step.text
  })
}

function sameProgress(left: WorkingPlanStep[], right: WorkingPlanStep[]): boolean {
  if (left.length !== right.length) return false
  return left.every((step, index) => {
    const candidate = right[index]
    return candidate?.status === step.status
      && candidate.blocker?.kind === step.blocker?.kind
      && candidate.blocker?.approvalId === step.blocker?.approvalId
  })
}

function applyDraftStructure(
  current: WorkingPlanStep[],
  draft: WorkingPlanStructureStep[],
): WorkingPlanStep[] {
  const byId = new Map(current.map((step) => [step.id, step]))
  return draft.map((step): WorkingPlanStep => {
    const prior = byId.get(step.id)
    return {
      id: step.id,
      text: step.text,
      status: prior?.status ?? "pending",
      ...(prior?.blocker ? { blocker: prior.blocker } : {}),
    }
  })
}

function renderWorkingPlanMarkdown(steps: WorkingPlanStep[]): string {
  const body = steps.map((step, index) => {
    const text = step.text.replaceAll("\n", "\n   ")
    return `${index + 1}. ${text}`
  }).join("\n")
  return `# Working plan\n\n${body}${body ? "\n" : ""}`
}
