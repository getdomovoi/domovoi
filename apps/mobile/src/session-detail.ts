import {
  boundedClientThread,
  maximumSessionPromptCharacters,
  type ApprovalDecision,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

type ThreadItem = WorkspaceSnapshot["thread"][number]

export type ThreadEntry = {
  id: string
  // Who is speaking decides how the entry is drawn: the person's own words sit
  // on the right, the agent answers on the left, and everything the system
  // recorded is a quieter note between them.
  voice: "you" | "agent" | "note"
  body: string
  meta: string | undefined
}

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
  // A paused session is one the daemon has nothing running for, so offering to
  // pause it again would be a button that does nothing.
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

function entryFor(item: ThreadItem): ThreadEntry {
  switch (item.kind) {
    case "user":
      return { id: item.id, voice: "you", body: item.body, meta: undefined }
    case "assistant":
      return { id: item.id, voice: "agent", body: item.body, meta: undefined }
    case "system":
      return { id: item.id, voice: "note", body: item.body, meta: item.detail }
    case "checkpoint":
      return {
        id: item.id,
        voice: "note",
        body: item.label,
        meta: item.commit ? item.commit.slice(0, 7) : undefined,
      }
    case "receipt":
      return {
        id: item.id,
        voice: "note",
        body: `${decisionLabels[item.decision]}: ${item.operation}`,
        meta: item.explanation ?? `${item.client} · ${item.checkpoint}`,
      }
    case "tool":
      return {
        id: item.id,
        voice: "note",
        body: item.title,
        // Tool output is desktop material. The phone says what ran and how it
        // ended, which is all a decision needs.
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
): SendReadiness {
  const readOnly = readOnlyReasons[session.state]
  if (readOnly) return { can: false, reason: readOnly }
  if (!session.workspacePath || !session.providerThreadId) {
    return { can: false, reason: "This session has no worktree or provider thread yet." }
  }
  if (hasApproval) {
    return { can: true, hint: "An approval is waiting. Answering it may be the faster reply." }
  }
  if (session.activeTurnId) {
    return { can: true, hint: "A turn is running. This steers it rather than starting a new one." }
  }
  return { can: true, hint: undefined }
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
): SessionDetail | undefined {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return undefined
  const thread = threadEntries(snapshot, sessionId)
  const approvalId = snapshot.approvals.find(
    (approval) => approval.sessionId === sessionId,
  )?.id
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
    pausable: isPausable(session),
    sending: sendReadiness(session, approvalId !== undefined),
  }
}
