import type {
  ProviderPromptHandoffDelivery,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"

const contextBudget = 24_000
const maximumThreadItems = 40

function truncate(value: string | undefined, length: number): string | undefined {
  if (!value || value.length <= length) return value
  return `${value.slice(0, length - 1)}…`
}

function serialize(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

type HandoffContext = {
  handoff: string
  worktree: string | undefined
  changedFiles: number
  tests: { passed: number; failed: number }
  history: { kind: string; body: string | undefined }[]
  artifacts: {
    id: string
    title: string
    type: string
    revision: number
    path: string | undefined
    content: string | undefined
  }[]
  openAnnotations: {
    id: string
    artifactId: string
    body: string | undefined
    anchor: WorkspaceSnapshot["annotations"][number]["anchor"]
  }[]
}

type HandoffOmissions = { threadItems: number; artifacts: number; annotations: number }

export type HandoffInclusion = { history: number; annotations: number; artifacts: number }

export type PreparedHandoffContext =
  | { status: "not-required" }
  | { status: "delivered"; context: HandoffContext; omitted: HandoffOmissions }

export function prepareHandoffContext(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
): PreparedHandoffContext {
  const sessionThread = snapshot.thread.filter((item) => item.sessionId === sessionId)
  const handoffIndex = sessionThread.findLastIndex(
    (item) => item.kind === "system"
      && (item.id.startsWith("handoff-") || item.body.startsWith("Handed off ")),
  )
  if (handoffIndex < 0) return { status: "not-required" }
  if (sessionThread.slice(handoffIndex + 1).some(
    (item) => item.kind === "user" || item.kind === "assistant",
  )) {
    return { status: "not-required" }
  }

  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  const handoff = sessionThread[handoffIndex]
  const allHistory = sessionThread
    .slice(0, handoffIndex)
    .filter((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "system")
  const history = allHistory.slice(-maximumThreadItems)
    .map((item) => ({ kind: item.kind, body: truncate(item.body, 2_000) }))
  const hasWorkingPlan = snapshot.workingPlans.some((plan) => plan.sessionId === sessionId)
  const artifacts = snapshot.artifacts
    .filter((artifact) => artifact.sessionId === sessionId)
    // Structured plan state is delivered separately. Replaying an older plan
    // artifact beside it would give the next provider two competing plans.
    .filter((artifact) => !hasWorkingPlan || artifact.type !== "plan")
    .map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      type: artifact.type,
      revision: artifact.revision,
      path: artifact.path,
      content: truncate(artifact.content, 6_000),
    }))
  const openAnnotations = snapshot.annotations
    .filter((annotation) => annotation.sessionId === sessionId && annotation.status === "open")
    .map((annotation) => ({
      id: annotation.id,
      artifactId: annotation.artifactId,
      body: truncate(annotation.body, 2_000),
      anchor: annotation.anchor,
    }))
  const context: HandoffContext = {
    handoff: handoff?.kind === "system" ? handoff.body : "Provider handoff",
    worktree: session?.workspacePath,
    changedFiles: session?.changedFiles ?? 0,
    tests: { passed: session?.testsPassed ?? 0, failed: session?.testsFailed ?? 0 },
    history,
    artifacts,
    openAnnotations,
  }
  const omitted: HandoffOmissions = {
    threadItems: Math.max(0, allHistory.length - history.length),
    artifacts: 0,
    annotations: 0,
  }
  while (serialize(context).length > contextBudget) {
    if (context.history.length) {
      context.history.shift()
      omitted.threadItems += 1
    } else if (context.openAnnotations.length) {
      context.openAnnotations.pop()
      omitted.annotations += 1
    } else if (context.artifacts.length) {
      context.artifacts.pop()
      omitted.artifacts += 1
    } else break
  }

  return { status: "delivered", context, omitted }
}

export function handoffInclusion(prepared: PreparedHandoffContext): HandoffInclusion {
  if (prepared.status !== "delivered") return { history: 0, annotations: 0, artifacts: 0 }
  return {
    history: prepared.context.history.length,
    annotations: prepared.context.openAnnotations.length,
    artifacts: prepared.context.artifacts.length,
  }
}

export function renderHandoffContext(
  prepared: PreparedHandoffContext,
  included: HandoffInclusion,
  userPrompt: string,
): { prompt: string; delivery: ProviderPromptHandoffDelivery } {
  if (prepared.status !== "delivered") {
    return { prompt: userPrompt, delivery: { status: "not-required" } }
  }
  const { context } = prepared
  const history = context.history.slice(
    Math.max(0, context.history.length - included.history),
  )
  const artifacts = context.artifacts.slice(0, included.artifacts)
  const openAnnotations = context.openAnnotations.slice(0, included.annotations)
  const omitted: HandoffOmissions = {
    threadItems: prepared.omitted.threadItems + context.history.length - history.length,
    artifacts: prepared.omitted.artifacts + context.artifacts.length - artifacts.length,
    annotations: prepared.omitted.annotations
      + context.openAnnotations.length
      - openAnnotations.length,
  }

  return {
    prompt: [
      "Domovoi handed this session across providers. Use only the documented state below; hidden reasoning and provider caches were not transferred.",
      "<domovoi_handoff_context>",
      serialize({ ...context, history, artifacts, openAnnotations }),
      "</domovoi_handoff_context>",
      "",
      "<user_request>",
      userPrompt,
      "</user_request>",
    ].join("\n"),
    delivery: { status: "delivered", omitted },
  }
}

export function prepareHandoffPrompt(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  userPrompt: string,
): { prompt: string; delivery: ProviderPromptHandoffDelivery } {
  const prepared = prepareHandoffContext(snapshot, sessionId)
  return renderHandoffContext(prepared, handoffInclusion(prepared), userPrompt)
}

export function agentPromptWithHandoff(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  userPrompt: string,
): string {
  return prepareHandoffPrompt(snapshot, sessionId, userPrompt).prompt
}
