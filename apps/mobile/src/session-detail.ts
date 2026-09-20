import {
  boundedClientThread,
  maximumSessionPromptCharacters,
  type ApprovalDecision,
  type ClientAccess,
  type PolicyRefusalThreadItem,
  type QueuedSessionSend,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { DaemonStatus } from "./lib/daemon"

type ThreadItem = WorkspaceSnapshot["thread"][number]

export type ThreadEntry =
  | {
    id: string
    kind: "message"
    voice: "you" | "agent"
    body: string
  }
  | {
    id: string
    kind: "note"
    body: string
    meta: string | undefined
  }
  | {
    id: string
    kind: "receipt"
    decision: string
    operation: string
    explanation: string | undefined
    attribution: string
    checkpoint: string
    duration: string | undefined
  }
  | ({ id: string, kind: "policy-refusal" } & Pick<
    PolicyRefusalThreadItem,
    "operation" | "command" | "rule" | "setBy" | "scope" | "remedy"
  >)

export type SessionDetail = {
  id: string
  title: string
  runtime: string
  mode: string
  state: string
  entries: ThreadEntry[]
  // The count the phone dropped rather than the count it holds, because a
  // person scrolling to the top deserves to know the thread starts mid-way.
  omitted: number
  approvalId: string | undefined
  policyRefusal: Extract<ThreadEntry, { kind: "policy-refusal" }> | undefined
  queuedSend: QueuedSessionSend | undefined
  activeTurn: boolean
  pausable: boolean
  sending: SendReadiness
}

// Sending is either refused with the daemon's own reason, or allowed with a
// note about what the message will actually do. The two are kept apart so a
// screen cannot render a refusal as a hint or the other way round.
export type SendReadiness =
  | { can: false, reason: string }
  | { can: true, hint: string | undefined }

const decisionLabels: Record<ApprovalDecision, string> = {
  "allow-once": "Allowed once",
  "always-project": "Allowed for this project",
  deny: "Denied",
  "deny-explain": "Denied with an explanation",
}

// Only a full commit SHA is safe to shorten. Anything else the daemon puts
// here is a name, and half a name is a different name.
function shortReference(reference: string): string {
  return /^[0-9a-f]{40}$/.test(reference) ? reference.slice(0, 7) : reference
}

function credentialReference(clientId: string): string {
  const normalized = clientId.replace(/^device-/, "device ")
  if (normalized.length <= 16) return normalized
  return `${normalized.slice(0, 11)}…${normalized.slice(-4)}`
}

function entryFor(item: ThreadItem): ThreadEntry {
  switch (item.kind) {
    case "user":
      return { id: item.id, kind: "message", voice: "you", body: item.body }
    case "assistant":
      return { id: item.id, kind: "message", voice: "agent", body: item.body }
    case "system":
      return { id: item.id, kind: "note", body: item.body, meta: item.detail }
    case "checkpoint":
      return {
        id: item.id,
        kind: "note",
        body: item.label,
        meta: item.commit ? item.commit.slice(0, 7) : undefined,
      }
    case "receipt": {
      const attribution = item.clientId
        ? `${item.client} · ${credentialReference(item.clientId)}`
        : item.client
      return {
        id: item.id,
        kind: "receipt",
        decision: decisionLabels[item.decision],
        operation: item.operation,
        explanation: item.explanation,
        attribution,
        checkpoint: item.checkpoint === "unavailable" ? "no checkpoint" : shortReference(item.checkpoint),
        duration: item.decisionDurationMs === undefined
          ? undefined
          : `${Math.round(item.decisionDurationMs / 1_000)}s`,
      }
    }
    case "policy-refusal":
      return {
        id: item.id,
        kind: "policy-refusal",
        operation: item.operation,
        command: item.command,
        rule: item.rule,
        setBy: item.setBy,
        scope: item.scope,
        remedy: item.remedy,
      }
    case "tool":
      return {
        id: item.id,
        kind: "note",
        body: item.title,
        meta: `${item.tool} · ${item.status}`,
      }
  }
}

export function threadEntries(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
): { entries: ThreadEntry[], omitted: number } {
  const mine = snapshot.thread.filter((item) => item.sessionId === sessionId)
  const bounded = boundedClientThread(mine, sessionId)
  return { entries: bounded.map(entryFor), omitted: mine.length - bounded.length }
}

// The daemon refuses to pause a session it considers read-only, and it stops
// nothing for a session that is not holding a turn. Both are mirrored here so
// the phone offers a button that will do something rather than one that errors.
const readOnlyStates = new Set<WorkspaceSnapshot["sessions"][number]["state"]>([
  "archiving",
  "archived",
  "transferring",
  "transferred",
  "ownership-conflict",
])

export function isPausable(session: WorkspaceSnapshot["sessions"][number]): boolean {
  if (readOnlyStates.has(session.state)) return false
  return Boolean(session.providerThreadId && session.activeTurnId)
}

const readOnlyReasons: Partial<Record<
  WorkspaceSnapshot["sessions"][number]["state"],
  string
>> = {
  archiving: "This session is being archived, so it is read-only.",
  archived: "Archived sessions are read-only.",
  transferring: "Ownership of this session is moving, so it is read-only.",
  transferred: "This session belongs to another machine now.",
  "ownership-conflict": "This session has conflicting owners and is read-only.",
}

// The daemon refuses a send for exactly two reasons, and they are mirrored here
// so the composer is disabled with the real reason instead of failing after the
// person has typed. A turn already running is not one of them: the daemon
// steers that turn rather than starting another, which is a different thing to
// do with a message and worth saying, not worth blocking.
export function sendReadiness(
  session: WorkspaceSnapshot["sessions"][number],
  hasApproval: boolean,
  access: ClientAccess = "full",
): SendReadiness {
  if (access === "watching") {
    return { can: false, reason: "Watching only. This phone can read the session but cannot change it." }
  }
  const readOnly = readOnlyReasons[session.state]
  if (readOnly) return { can: false, reason: readOnly }
  if (!session.workspacePath || !session.providerThreadId) {
    return { can: false, reason: "This session has no worktree or provider thread yet." }
  }
  if (hasApproval) {
    return { can: true, hint: "An approval is waiting. Answering it may be the faster reply." }
  }
  if (session.activeTurnId) {
    return { can: true, hint: "A turn is running. Sending replaces the message queued for the next turn." }
  }
  return { can: true, hint: undefined }
}

// The socket is a reason of its own, checked over the session's. A send that
// cannot reach the daemon is refused before the person types, and the reason
// says what is still true: the session is on the machine and unchanged.
export function sendReadinessOverSocket(status: DaemonStatus, readiness: SendReadiness): SendReadiness {
  if (status === "open") return readiness
  const state = status === "connecting" ? "Connecting" : "Not connected"
  return { can: false, reason: `${state}. The session is still on the machine; this reply cannot reach it yet.` }
}

// The daemon trims before it measures, so a prompt of nothing but spaces is
// refused here for the same reason it would be refused there.
export function promptProblem(draft: string): string | undefined {
  const trimmed = draft.trim()
  if (trimmed.length === 0) return "Write something to send."
  if (trimmed.length > maximumSessionPromptCharacters) {
    return `That is longer than the ${maximumSessionPromptCharacters} characters a prompt may be.`
  }
  return undefined
}

export function sessionDetail(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
  access: ClientAccess = "full",
): SessionDetail | undefined {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return undefined
  const thread = threadEntries(snapshot, sessionId)
  const approvalId = snapshot.approvals.find(
    (approval) => approval.sessionId === sessionId,
  )?.id
  const latestEntry = thread.entries.at(-1)
  const policyRefusal = latestEntry?.kind === "policy-refusal" ? latestEntry : undefined
  const queuedSend = snapshot.queuedSends?.find((queued) => queued.sessionId === sessionId)
  return {
    id: session.id,
    title: session.title,
    runtime: `${session.runtime.provider} · ${session.runtime.model}`,
    mode: session.runtime.auto
      ? `${session.runtime.permissionMode} auto`
      : session.runtime.permissionMode,
    state: session.state,
    entries: thread.entries,
    omitted: thread.omitted,
    approvalId,
    policyRefusal,
    queuedSend,
    activeTurn: Boolean(session.activeTurnId),
    pausable: isPausable(session),
    sending: sendReadiness(session, approvalId !== undefined, access),
  }
}
