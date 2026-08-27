import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

const contextBudget = 24_000
const maximumThreadItems = 40

function truncate(value: string | undefined, length: number): string | undefined {
  if (!value || value.length <= length) return value
  return `${value.slice(0, length - 1)}…`
}

function serialize(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

export function agentPromptWithHandoff(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  userPrompt: string,
): string {
  const sessionThread = snapshot.thread.filter((item) => item.sessionId === sessionId)
  const handoffIndex = sessionThread.findLastIndex(
    (item) => item.kind === "system"
      && (item.id.startsWith("handoff-") || item.body.startsWith("Handed off ")),
  )
  if (handoffIndex < 0) return userPrompt
  if (sessionThread.slice(handoffIndex + 1).some(
    (item) => item.kind === "user" || item.kind === "assistant",
  )) {
    return userPrompt
  }

  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  const handoff = sessionThread[handoffIndex]
  const history = sessionThread
    .slice(0, handoffIndex)
    .filter((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "system")
    .slice(-maximumThreadItems)
    .map((item) => ({ kind: item.kind, body: truncate(item.body, 2_000) }))
  const artifacts = snapshot.artifacts
    .filter((artifact) => artifact.sessionId === sessionId)
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
  const context = {
    handoff: handoff?.kind === "system" ? handoff.body : "Provider handoff",
    worktree: session?.workspacePath,
    changedFiles: session?.changedFiles ?? 0,
    tests: { passed: session?.testsPassed ?? 0, failed: session?.testsFailed ?? 0 },
    history,
    artifacts,
    openAnnotations,
  }
  let boundedContext = serialize(context)
  while (boundedContext.length > contextBudget) {
    if (context.history.length) context.history.shift()
    else if (context.openAnnotations.length) context.openAnnotations.pop()
    else if (context.artifacts.length) context.artifacts.pop()
    else break
    boundedContext = serialize(context)
  }

  return [
    "Domovoi handed this session across providers. Use only the documented state below; hidden reasoning and provider caches were not transferred.",
    "<domovoi_handoff_context>",
    boundedContext,
    "</domovoi_handoff_context>",
    "",
    "<user_request>",
    userPrompt,
    "</user_request>",
  ].join("\n")
}
