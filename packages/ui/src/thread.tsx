import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArchiveIcon,
  ArrowDownIcon,
  BotIcon,
  CheckIcon,
  CircleStopIcon,
  FolderOpenIcon,
} from "lucide-react"
import type {
  ApprovalRequest,
  ApprovalDecision,
  ClientAccess,
  ProviderFailure,
  ProviderModel,
  RpcParams,
  Runtime,
  FleetEntry,
  SessionAttachment,
  SessionSummary,
  SessionTransferParams,
  SessionTransferResult,
  SkillSummary,
  SessionTransferPreview,
  SessionTransferPreviewParams,
  SessionUsage,
  SessionTurn,
  RuntimeDiscoverResult,
  UsageWindow,
  TurnSkillSelection,
  ThreadItem,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { selectableTurnSkills, threadFollowPillText, sessionTransferRefusalMessage, toolFileEntries, turnSkillSelectionFor } from "@getdomovoi/protocol"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import {
  readOnlySessionNotice,
  sessionConflictOffer,
  sessionRecoveryOffer,
  type SessionRecoveryOffer,
} from "./session-recovery.js"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { sessionDraftStore } from "./session-draft"
import { useThreadFollow } from "./thread-follow"
import { MachineSwitcher } from "./machine-switcher.js"
import { fleetMachines } from "./fleet-entries.js"
import { PairMachineDialog } from "./pair-machine-dialog.js"
import { TransferSessionDialog } from "./transfer-session-dialog.js"
import type { PairedMachine, PairMachineRequest } from "./pair-machine.js"
import { cn } from "./lib/utils"
import { DomovoiMark } from "./domovoi-mark"
import { ApprovalReceipt, receiptCheckpointTaken } from "./approval-receipt"
import { PlanStrip } from "./plan-strip"
import { effortName } from "./effort-scales.js"
import { permissionModeLabel, withPermissionMode } from "./permission-mode.js"
import type { WorkingPlanEdit } from "./plan-step-editor.js"
import { groupThreadActivity, type ThreadRow } from "./thread-activity-groups"
import { ThreadFileChips } from "./thread-file-chips"
import { TurnActivity } from "./turn-activity"
import { CheckpointRestore, checkpointRestoreBlocked } from "./checkpoint-actions.js"
import {
  heldAfter,
  submitFromComposer,
  type FailedAttempt,
  type QueuedMessage,
} from "./turn-queue"
import { PromptDeliveryNote } from "./prompt-delivery-note"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { MarkdownQuickView } from "./markdown-quick-view"
import { stripPlanTags } from "./plan-tag-strip"
import { PromptEditorDialog } from "./prompt-editor"
import {
  activeSessionCount,
  activeThreadKey,
  forkSessionBlockedReason,
  localFleetEntry,
  localMachineEntry,
  renderedThreadForActiveSession,
  sessionIsArchiveReadOnly,
} from "./workspace-selectors"
import { FailedReadState } from "./failed-read-state"
import { PolicyRefusalCard } from "./policy-refusal-card"
import { ApprovalCard } from "./approval-card"
import { DaemonRpcError } from "./client"
import { slashIntent, type SlashIntentContext } from "./composer-slash"
import { ThreadComposer } from "./thread-composer"
import { attachmentName, desktopInlineLineLimit, pasteOutcome } from "./desktop-attachments"
import { NothingHasRunYet, WorktreeReadyHeader } from "./thread-new-session"
import { startOpenerRef } from "./start-handoff"

// The states name a meaning rather than a colour now, so the palette lives in
// StatusDot alone instead of being restated per surface.
//
// A status dot shows a state, never an event. A transfer is something that
// happened to a session, not a condition it is in: after it completes the
// session is running, idle or waiting on a gate, on the new machine. The test
// that settles it is a session that moved and then raised a gate — it cannot be
// both handoff-blue and gate-amber, and the gate is obviously the answer, which
// means handoff was never a state, just a recent event wearing one's clothes.
// Same error as calling provider handoffs "Transfers" in the filter list. A move
// belongs in History, where events live.
const statusMeaning: Record<SessionSummary["state"], StatusMeaning> = {
  active: "online",
  waiting: "waiting",
  idle: "idle",
  done: "idle",
  failed: "offline",
  archiving: "waiting",
  archived: "idle",
  // A session mid-move is doing something; one that has moved is a recovery
  // point on this machine and reads as quiet rather than failed.
  transferring: "waiting",
  transferred: "idle",
  // Two machines claim this session. That is not quiet like a moved session,
  // and it is not in flight like a moving one, so it reads as a problem.
  "ownership-conflict": "offline",
}

// Exported so a test can prove every session state has a meaning. The map is
// keyed on the union, so a new state fails typecheck rather than rendering no
// dot, and this proves the table is reachable rather than only well-typed.
export function sessionStatusMeaning(session: Pick<SessionSummary, "state">): StatusMeaning {
  return statusMeaning[session.state]
}
export function providerFailureActionCopy(failure: ProviderFailure): string {
  switch (failure.action) {
    case "sign-in": return "Open Provider settings and sign in again."
    case "retry": {
      if (failure.kind === "rate-limit") return "Retry the message after the provider cooldown."
      if (failure.kind === "transport") return "Retry the message after the provider reconnects."
      return "Retry the message, or review Provider settings if the failure continues."
    }
    case "check-quota": return "Check the provider quota or billing plan, then retry."
    case "change-model": return "Choose another model in the runtime controls, then retry."
    case "shorten-context": return "Shorten the turn, or start a new session from a checkpoint."
    case "review-changes": return "A program on this machine used the provider server's password to answer an approval, and what it approved may have run. Review the session's changes. Starting the provider again continues the session in a new provider session, without its earlier conversation."
  }
}


export function SessionRow({
  session,
  active,
  onActivate,
}: {
  session: SessionSummary
  active: boolean
  onActivate: (sessionId: string) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onActivate(session.id)}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent",
      )}
    >
      <span className="flex w-full items-start gap-2">
        <StatusDot
          meaning={statusMeaning[session.state]}
          label={`Status: ${session.state}`}
          size="inline"
          labelHidden
          className={cn("mt-1.5", session.state === "active" && "motion-safe:animate-pulse")}
        />
        <span className="line-clamp-2 text-[12.5px] font-medium leading-[1.35]">{session.title}</span>
      </span>
      <span className="ml-3.5 flex flex-wrap items-center gap-1">
        <Badge variant="machine">{session.runtime.provider}/{session.runtime.model}</Badge>
        <Badge variant="outline" className="font-machine text-mono-xs uppercase">
          {session.runtime.permissionMode}
        </Badge>
        {session.runtime.auto ? <Badge variant="warning">Auto</Badge> : null}
        {session.state === "waiting" ? (
          <span className="ml-auto text-eyebrow uppercase text-warning">Approval</span>
        ) : null}
      </span>
    </button>
  )
}


export const CheckpointThreadItem = memo(function CheckpointThreadItem({
  item,
  disabled,
  onRestore,
}: {
  item: Extract<ThreadItem, { kind: "checkpoint" }>
  disabled: boolean
  onRestore: (checkpointId: string) => void
}) {
  return (
    <div className="flex items-center gap-1 self-center rounded-full border bg-card py-1 pr-1 pl-3 font-machine text-mono-xs text-faint">
      <span>Checkpoint · {item.label}</span>
      {item.commit ? (
        <CheckpointRestore checkpointId={item.id} label={item.label} disabled={disabled} onRestore={onRestore} />
      ) : null}
    </div>
  )
})

// I69, 2026-09-23: the confirmation says exactly what archive does. The
// daemon takes a final checkpoint, stops the agent and its terminals and
// removes the worktree directory; the branch, that checkpoint and the thread
// stay. The daemon counts unmerged files only while archiving, so before it
// the kept branch reads "as it is" rather than implying a count (ruled
// 2026-09-23).
export const archiveSessionDescription = "Domovoi takes a final checkpoint, stops the agent and its terminals, then removes the worktree directory. Nothing is merged."

export function ArchiveConfirmBody({ worktreePath, branch }: { worktreePath?: string | undefined; branch?: string | undefined }) {
  const eyebrow = "text-[10.5px] tracking-[0.13em] text-faint"
  return (
    <div className="flex flex-col gap-3 text-[12px] leading-[1.5]">
      <div className="overflow-hidden rounded-lg border">
        <p className={`m-0 border-b px-3 py-2 ${eyebrow}`} id="archive-removed">REMOVED</p>
        <ul aria-labelledby="archive-removed" className="m-0 list-none p-0">
          <li className="flex flex-col gap-0.5 px-3 py-2">
            <span>The worktree directory</span>
            {worktreePath ? <span className="truncate font-machine text-[10.5px] text-faint" title={worktreePath}>{worktreePath}</span> : null}
          </li>
          <li className="border-t px-3 py-2">The agent and its terminals, stopped</li>
        </ul>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <p className={`m-0 border-b px-3 py-2 ${eyebrow}`} id="archive-kept">KEPT</p>
        <ul aria-labelledby="archive-kept" className="m-0 list-none p-0">
          <li className="px-3 py-2">{branch ? <>The branch <span className="font-machine">{branch}</span></> : "The session branch"}, as it is</li>
          <li className="border-t px-3 py-2">The final checkpoint, taken on that branch</li>
          <li className="border-t px-3 py-2">The thread, readable here</li>
        </ul>
      </div>
      <p className="m-0 text-[11.5px] text-muted-foreground">This cannot be undone. An archived session cannot be forked, unarchived or sent to.</p>
    </div>
  )
}

// I69: the head of an archived thread says what archive did, naming the kept
// branch and the files never merged when the daemon reported them.
function ArchivedSessionNotice({ session }: { session: SessionSummary }) {
  const time = session.archivedAt ? threadClock.format(new Date(session.archivedAt)) : undefined
  const unmerged = session.unmergedFiles === undefined ? undefined : `${session.unmergedFiles} ${session.unmergedFiles === 1 ? "file" : "files"} never merged`
  const meta = [time ? `archived ${time}` : undefined, session.archiveCheckpoint?.slice(0, 7), unmerged].filter(Boolean).join(" · ")
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-accent px-4 py-3" role="status">
      <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-muted-foreground" />
      <span className="min-w-0 flex-1 text-[12px] leading-[1.5]">
        Archived and read-only. The worktree was removed. {session.branch ? <>Branch <span className="font-machine">{session.branch}</span></> : "The session branch"} and its final checkpoint are kept.
      </span>
      {meta ? <span className="font-machine text-[10.5px] text-faint">{meta}</span> : null}
      <Button variant="outline" size="sm" disabled title="Not built yet">
        Start a new session from this branch
        <span className="font-machine text-[10.5px] text-faint">later</span>
      </Button>
    </div>
  )
}

const threadClock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })

// The rows the daemon writes when a pause ended a session's turn. A failed
// interrupt writes "Pause failed for <client>." instead.
function pauseRows(thread: readonly ThreadItem[], sessionId: string): ThreadItem[] {
  return thread.filter((item) => item.sessionId === sessionId && item.kind === "system" && /^Paused by .+\.$/u.test(item.body))
}

// The design's paused notice, with copy that is true today: the turn ended and
// the session holds nothing back, so there is nothing to resume (ruled Q361 A).
function StoppedSessionNotice({ at }: { at: Date }) {
  return (
    <div
      role="status"
      aria-label="Session stopped"
      className="flex flex-none flex-wrap items-center gap-[11px] border-b border-info-border bg-info-background px-4 py-[11px]"
    >
      <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-info" />
      <span className="text-[12.5px] text-info-foreground">Stopped. The turn ended. The next message you send starts the next turn.</span>
      <span className="font-machine text-[10.5px] text-info-dim">stopped {threadClock.format(at)} · from this client</span>
    </div>
  )
}

// v2 opens a conversation with one mono rule naming where the work happens, and
// lets it scroll away. The session title is already in the command palette pill
// at the top of the window, so a fixed banner would say it twice and take the
// height the thread wants.
function ThreadStartLine({
  project,
  branch,
  workspacePath,
  startedAt,
}: {
  project?: string | undefined
  branch?: string | undefined
  workspacePath?: string | undefined
  startedAt?: string | undefined
}) {
  const worktree = workspacePath?.split(/[\\/]/u).filter(Boolean).at(-1)
  const parts = [project, branch, worktree].filter((part): part is string => Boolean(part))
  if (parts.length === 0 && !startedAt) return null

  return (
    <div className="flex items-center gap-2.5 text-faint">
      {parts.length > 0 ? <span className="font-machine text-[11px]">{parts.join(" · ")}</span> : null}
      <span aria-hidden className="h-px flex-1 bg-border" />
      {startedAt ? (
        <span className="font-machine text-[11px]">started {threadClock.format(new Date(startedAt))}</span>
      ) : null}
    </div>
  )
}

export function SessionReadOnlyNotice({
  session,
  otherLabel,
  disabled,
  pending,
  onRelease,
}: {
  session: SessionSummary
  otherLabel: string | undefined
  disabled: boolean
  pending: boolean
  onRelease: (offer: SessionRecoveryOffer) => void
}) {
  const notice = readOnlySessionNotice(session, otherLabel)
  if (!notice) return null
  // Only one of these can apply: a frozen move the daemon gave up on, or a
  // conflict. Both end in a confirmation the operator has to make in words.
  const offer = sessionRecoveryOffer(session, otherLabel) ?? sessionConflictOffer(session, otherLabel)
  const destructive = session.state === "ownership-conflict"

  return (
    <Alert variant={destructive ? "destructive" : "default"} className="mx-auto max-w-[var(--shell-thread)]">
      {destructive ? <CircleStopIcon /> : <ArchiveIcon />}
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        {notice.detail}
        {offer ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={disabled || pending}>
                {offer.kind === "keep-target" ? "Settle this" : "Release this session"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{offer.title}</AlertDialogTitle>
                <AlertDialogDescription>{offer.detail}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => onRelease(offer)}>
                  {offer.confirmLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function Thread({
  snapshot,
  connected,
  clientAccess = "full",
  emergencyStopPending = false,
  queued,
  onQueuedChange,
  failures,
  onDismissFailure,
  fleet,
  transferFleet,
  admittedMachines,
  currentMachineId,
  onResolve,
  onSetRuntime,
  onRestartProviderThread,
  onForkSession,
  onListModels,
  onNewSession,
  onSend,
  onRestoreCheckpoint,
  restoreBusy = false,
  pendingTransferTargetId = null,
  onPendingTransferTargetChange,
  onPauseSession,
  onPairMachine,
  onSelectMachine,
  onTransferSession,
  onPreviewTransfer,
  onReleaseSession,
  usage = null,
  usageToday = null,
  loadLatestTurn,
  onDiscoverRuntime,
  onEditPlan,
  onDiscardPlanEdit,
  onOpenPlanPreview,
  onOpenSheet,
  machineMenuRequest,
  skillNames,
  skillCatalog,
  surface = "desktop",
}: {
  snapshot: WorkspaceSnapshot
  connected: boolean
  clientAccess?: ClientAccess
  emergencyStopPending?: boolean | undefined
  // Bound to the session it was typed in: releasing it into whatever session
  // happens to be open later would send someone's message to the wrong agent.
  queued?: QueuedMessage | undefined
  onQueuedChange: (next: QueuedMessage | undefined) => void
  // Sends that never came back. Shown beside the queue rather than in it,
  // because they are things that did not complete, not things that will.
  failures?: readonly FailedAttempt[] | undefined
  onDismissFailure?: ((id: string) => void) | undefined
  fleet?: FleetEntry[] | undefined
  transferFleet?: FleetEntry[] | undefined
  admittedMachines?: ReadonlySet<string> | undefined
  currentMachineId?: string | undefined
  // The revision is the one the card showed, so the daemon can refuse an
  // Allow given to a card it has since rewritten.
  onResolve: (
    approvalId: string,
    decision: ApprovalDecision,
    explanation: string | undefined,
    revision: number,
  ) => Promise<void>
  onSetRuntime: (runtime: Runtime) => Promise<void>
  onRestartProviderThread?: (() => Promise<void>) | undefined
  onForkSession: (input: Omit<RpcParams<"session.fork">, "client">) => Promise<void>
  onListModels: (provider: string) => Promise<ProviderModel[]>
  onNewSession: () => void
  onSend: (
    sessionId: string,
    prompt: string,
    skillSelection?: TurnSkillSelection,
    attachments?: SessionAttachment[],
  ) => Promise<void>
  onCheckpoint: (sessionId: string) => Promise<void>
  onRestoreCheckpoint: (sessionId: string, checkpointId: string) => Promise<void>
  // Set while a restore started anywhere in the shell is still running.
  restoreBusy?: boolean
  // A transfer target named outside the thread, by the launcher.
  pendingTransferTargetId?: string | null | undefined
  onPendingTransferTargetChange?: ((machineId: string | null) => void) | undefined
  onPauseSession: (sessionId: string) => Promise<void>
  onPairMachine?: ((request: PairMachineRequest) => Promise<PairedMachine>) | undefined
  onSelectMachine?: ((machineId: string) => void) | undefined
  onTransferSession?: ((
    params: Omit<SessionTransferParams, "initiatedByClient">,
  ) => Promise<SessionTransferResult>) | undefined
  onPreviewTransfer?: ((
    params: Omit<SessionTransferPreviewParams, "initiatedByClient">,
  ) => Promise<SessionTransferPreview>) | undefined
  // One handler for both exits. The confirmation says which the operator made,
  // and the caller routes it, so this surface cannot send the wrong one.
  onReleaseSession?: ((params: {
    sessionId: string
    transferId: string
    confirmation: SessionRecoveryOffer["confirmation"]
  }) => Promise<unknown>) | undefined
  usage?: SessionUsage | null | undefined
  usageToday?: UsageWindow | null | undefined
  loadLatestTurn?: ((signal: AbortSignal) => Promise<SessionTurn | undefined>) | undefined
  // "Ask the agents again" in the model chip runs runtime.discover per harness.
  onDiscoverRuntime?: ((provider: string) => Promise<RuntimeDiscoverResult>) | undefined
  // The strip above the composer edits and discards through the same RPCs
  // the Plan preview card uses; the preview link opens that dock tab.
  onEditPlan?: ((sessionId: string, edit: WorkingPlanEdit) => Promise<void>) | undefined
  onDiscardPlanEdit?: ((sessionId: string, editId: string) => Promise<void>) | undefined
  onOpenPlanPreview?: (() => void) | undefined
  onOpenSheet?: (() => void) | undefined
  // Bumped by the sessions drawer's "Move to another machine" so the composer's
  // machine menu opens on the session it just activated.
  machineMenuRequest?: number | undefined
  skillNames?: Record<string, string> | undefined
  skillCatalog?: readonly SkillSummary[] | undefined
  surface?: "desktop" | "web" | undefined
}) {
  const watching = clientAccess === "watching"
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)
  const approval = active
    ? snapshot.approvals.find((candidate) => candidate.sessionId === active.id)
    : undefined
  // Switching sessions remounts this component, which resets the pending send,
  // the alerts and the receipts. That is correct for all of it except the part
  // the person typed, so the composer starts from the stored draft instead of
  // from empty. Everything else still resets.
  const draftSessionId = snapshot.activeSessionId
  const [prompt, setPrompt] = useState(() => sessionDraftStore.read(draftSessionId).prompt)
  const [attachments, setAttachments] = useState<SessionAttachment[]>(() => [...sessionDraftStore.read(draftSessionId).attachments])
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashOpen = connected && !watching && prompt.startsWith("/") && !slashDismissed
  const threadViewport = useRef<HTMLDivElement>(null)
  const previousThreadRows = useRef<readonly ThreadRow[]>([])
  const renderedThread = useMemo(() => renderedThreadForActiveSession(snapshot), [snapshot])
  const threadRows = useMemo(
    () => active
      ? groupThreadActivity(renderedThread, previousThreadRows.current)
      : [],
    [active, renderedThread],
  )
  useEffect(() => {
    previousThreadRows.current = threadRows
  }, [threadRows])
  // A turn that has not called a tool yet still has to say it is alive. Once
  // the turn has an activity row at the end of the thread, that row is the one
  // working, and a second row beside it would say the same thing twice.
  const lastRow = threadRows.at(-1)
  const workingRow = Boolean(active?.activeTurnId) && lastRow?.kind !== "activity"
  // The session carries no start time of its own, so the first thing said in it
  // is the honest one. An empty thread has not started yet and says nothing.
  const threadStartedAt = renderedThread[0]?.createdAt
  const follow = useThreadFollow(threadViewport, {
    itemCount: threadRows.length + (approval ? 1 : 0),
    gated: Boolean(approval),
    threadKey: activeThreadKey(snapshot),
  })
  const followPill = watching && follow.state === "gate"
    ? "Waiting on a full-access device"
    : threadFollowPillText(follow.state, follow.unseen)
  const [skillSelection, setSkillSelection] = useState<ReadonlySet<string> | undefined>(() => sessionDraftStore.read(draftSessionId).skillSelection)
  const [promptEditorOpen, setPromptEditorOpen] = useState(() => sessionDraftStore.read(draftSessionId).promptEditorOpen)
  const [editorPasteNote, setEditorPasteNote] = useState("")
  // A send clears the prompt, which writes an empty draft, which the store reads
  // as no draft at all. So nothing has to clear it by hand.
  useEffect(() => {
    sessionDraftStore.write(draftSessionId, { prompt, attachments, skillSelection, promptEditorOpen })
  }, [draftSessionId, prompt, attachments, skillSelection, promptEditorOpen])
  const [pairingMachine, setPairingMachine] = useState(false)
  // The machine menu's trigger is hidden and inert, so focus cannot go back to
  // it. Where focus was when the drawer asked for the menu is where it returns
  // when the menu closes, or a dialog the menu opened closes; failing that,
  // the message field.
  const focusBeforeMachineMenu = useRef<Element | null>(null)
  const seenMachineMenuRequest = useRef(machineMenuRequest)
  useEffect(() => {
    if (machineMenuRequest === undefined || machineMenuRequest === seenMachineMenuRequest.current) return
    seenMachineMenuRequest.current = machineMenuRequest
    focusBeforeMachineMenu.current = document.activeElement
  }, [machineMenuRequest])
  const returnFocusFromMachineMenu = (event: Event, { dialog }: { dialog: boolean }) => {
    const target = focusBeforeMachineMenu.current
    const focused = document.activeElement
    // Focus already somewhere real when the menu finishes closing: a dialog
    // the menu opened took it, and its own close returns it, or the person
    // moved it. Either way it stays.
    if (!dialog && focused && focused !== document.body && !focused.closest("[inert]")) {
      event.preventDefault()
      if (!focused.closest("[role=dialog], [role=alertdialog]")) focusBeforeMachineMenu.current = null
      return
    }
    // Opened some other way, such as /handoff: the dialog's own default holds.
    if (dialog && target === null) return
    event.preventDefault()
    focusBeforeMachineMenu.current = null
    if (target instanceof HTMLElement && target.isConnected && !target.closest("[inert]") && target !== document.body) {
      target.focus()
      return
    }
    document.querySelector<HTMLTextAreaElement>("[data-workspace-composer] textarea")?.focus()
  }
  const [ownTransferTargetId, setOwnTransferTargetId] = useState<string | null>(null)
  // The composer's machine menu and the launcher both name a target. The shell
  // owns it when it supplies one, so either route reaches the same dialog.
  const transferTargetId = pendingTransferTargetId ?? ownTransferTargetId
  const setTransferTargetId = (machineId: string | null) => {
    if (watching && machineId !== null) return
    setOwnTransferTargetId(machineId)
    onPendingTransferTargetChange?.(machineId)
  }
  const [transferReceipt, setTransferReceipt] = useState<SessionTransferReceipt | null>(null)
  // The turn this client stopped, and the pause rows the thread held before
  // the stop. The wire has no paused state: session.pause ends the running
  // turn and the next send starts another (ruled Q361 A). The daemon answers
  // the RPC successfully either way and records the outcome as a system row,
  // so only a new "Paused by <client>." row says the turn ended. Any later
  // turn retires the notice.
  const [stopped, setStopped] = useState<{ turnId: string, earlierPauseRows: ReadonlySet<string> }>()
  const runningTurnId = active?.activeTurnId
  useEffect(() => {
    if (runningTurnId && stopped && runningTurnId !== stopped.turnId) setStopped(undefined)
  }, [runningTurnId, stopped])
  const [pending, setPending] = useState(false)
  // Local only, and never a thread item. The daemon owns the thread, so an
  // in-flight message is shown beside it as a note, not forged into it.
  const [sending, setSending] = useState<string | null>(null)
  const [runtimePending, setRuntimePending] = useState(false)
  const [sendError, setSendError] = useState("")
  // `arrivedAt` is the pending gates (ids and revisions) when the refusal
  // arrived. It is cleared by the first change to them that keeps the gate.
  const [approvalRefusal, setApprovalRefusal] = useState<{ approvalId: string, message: string, arrivedAt?: string }>()
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null)
  const resolvingApproval = useRef<string | null>(null)
  // The gates pending in the latest snapshot, read when a refusal arrives to
  // place it: a refusal can come back after the snapshot has moved on.
  const pendingApprovalIds = useRef(new Set<string>())
  // Compared by content, not identity: every snapshot is a new object, and a
  // thread update that leaves the gates alone is not a change to them.
  const pendingApprovalsKey = snapshot.approvals.map((pending) => `${pending.id}@${pending.revision}`).join(" ")
  const latestApprovalsKey = useRef(pendingApprovalsKey)
  useEffect(() => {
    pendingApprovalIds.current = new Set(snapshot.approvals.map((pending) => pending.id))
    latestApprovalsKey.current = pendingApprovalsKey
    if (!approvalRefusal || pendingApprovalsKey === approvalRefusal.arrivedAt) return
    if (pendingApprovalIds.current.has(approvalRefusal.approvalId)) {
      if (approvalRefusal.arrivedAt !== undefined) setApprovalRefusal({ approvalId: approvalRefusal.approvalId, message: approvalRefusal.message })
      return
    }
    // The card held this refusal, and its gate has gone. The daemon answers
    // a withdrawn or no-longer-waiting gate with the error before the
    // snapshot that drops it. So a gate that leaves in the first change
    // after its refusal, with no receipt saying someone decided it (the
    // daemon names one receipt-<approval id>-...), was withdrawn: the
    // refusal moves above the composer rather than vanishing. A gate that
    // outlived a change and then left went for another reason, such as a
    // pause, a quarantine or an answer outside Domovoi. The refusal is then
    // about a decision nobody can make now, and it leaves with the card.
    const decided = snapshot.thread.some((item) => item.kind === "receipt" && item.id.startsWith(`receipt-${approvalRefusal.approvalId}-`))
    if (approvalRefusal.arrivedAt !== undefined && !decided) setSendError(approvalRefusal.message)
    setApprovalRefusal(undefined)
  }, [snapshot.approvals, snapshot.thread, pendingApprovalsKey, approvalRefusal])
  const [recoveryError, setRecoveryError] = useState("")
  const [runtimeError, setRuntimeError] = useState("")
  // A model change that could not carry the effort moved it to the new
  // model's default, or to the nearest level when the model names no
  // default. The effort menu says so until a level is picked or the runtime
  // moves on. Whether it moved to the default is read at render.
  const [effortDropped, setEffortDropped] = useState<{ sessionId: string, from: string, to: string }>()
  const [restartPending, setRestartPending] = useState(false)
  const [restartError, setRestartError] = useState("")
  const archiveReadOnly = sessionIsArchiveReadOnly(active)
  const readOnly = archiveReadOnly || watching
  const activeSessionId = active?.id
  const restoreCheckpoint = useCallback(async (checkpointId: string) => {
    if (!activeSessionId || checkpointRestoreBlocked(pending, readOnly)) return
    setPending(true)
    setSendError("")
    try {
      await onRestoreCheckpoint(activeSessionId, checkpointId)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The checkpoint could not be restored")
    } finally {
      setPending(false)
    }
  }, [activeSessionId, onRestoreCheckpoint, pending, readOnly])
  const restoreCheckpointFromRow = useCallback((checkpointId: string) => {
    void restoreCheckpoint(checkpointId)
  }, [restoreCheckpoint])
  // The effort chip offers what the session's model reports, read once per
  // provider change. Until a read answers, or when it fails, there is no chip.
  // Hooks sit above the no-session return.
  const activeProvider = active?.runtime.provider
  // Held with the provider it answered for, so a re-read keeps the chip up and
  // a provider change drops it until the new harness answers.
  const [providerModels, setProviderModels] = useState<{ provider: string, models: ProviderModel[] }>()
  useEffect(() => {
    if (!activeProvider) return
    let live = true
    void onListModels(activeProvider).then(
      (models) => { if (live) setProviderModels({ provider: activeProvider, models }) },
      () => { if (live) setProviderModels(undefined) },
    )
    return () => { live = false }
  }, [onListModels, activeProvider])
  // The editor answers a shortcut as well as its control, because a long prompt
  // usually starts at the keyboard.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
      if (event.key.toLowerCase() !== "e") return
      event.preventDefault()
      if (!watching) setPromptEditorOpen(true)
    }
    globalThis.addEventListener("keydown", onKeyDown)
    return () => globalThis.removeEventListener("keydown", onKeyDown)
  }, [watching])

  if (!active) {
    const hasProject = snapshot.project !== null
    return (
      <main className="flex h-full min-w-0 bg-background">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">{hasProject ? <BotIcon /> : <FolderOpenIcon />}</EmptyMedia>
            <EmptyTitle asChild>
              <h1>{hasProject ? "No session is open" : "No project is open"}</h1>
            </EmptyTitle>
            <EmptyDescription>
              {hasProject
                ? "Start a session to create an isolated worktree and talk to an agent."
                : "Open a local Git repository before starting an agent session."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {/* startOpenerRef registers a control that opens a session
                start: a refusal of that start may take focus from it (ruling
                Q410). */}
            <Button ref={startOpenerRef} disabled={watching} onClick={onNewSession}>
              {hasProject ? <BotIcon data-icon="inline-start" /> : <FolderOpenIcon data-icon="inline-start" />}
              {hasProject ? "New session" : "Open project"}
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    )
  }

  const entries = fleet ?? [localFleetEntry(snapshot)]
  const machines = fleetMachines(transferFleet ?? entries)
  const sourceMachine = machines.find(
    (machine) => machine.id === (currentMachineId ?? snapshot.machine.id),
  ) ?? localMachineEntry(snapshot)
  const transferTarget = transferTargetId
    ? machines.find((machine) => machine.id === transferTargetId)
    : undefined
  const selectableSkills = selectableTurnSkills(skillCatalog ?? [], snapshot.skillEnablements, snapshot.project?.id)
  const activeCheckpointIds = snapshot.thread.flatMap((item) =>
    item.sessionId === active.id && item.kind === "checkpoint" && item.commit ? [item.id] : []
  )
  const slashContext: SlashIntentContext = {
    checkpointIds: activeCheckpointIds,
    skills: selectableSkills,
    machines,
  }

  const providerRestartRequired = active.state === "failed" && !active.providerThreadId
  // The worktree of a session nothing has run in yet: no turn is running or
  // being sent, it has a worktree to be ready, and its thread holds only what
  // session.create writes (a session-start checkpoint and system rows), no
  // message, tool call, receipt or refusal. Ruled Q368 A.
  const nothingHasRun = !renderedThread.some((item) =>
    item.kind === "user" || item.kind === "assistant" || item.kind === "tool" || item.kind === "receipt" || item.kind === "policy-refusal"
  )
  const freshWorktree = nothingHasRun && !active.activeTurnId && sending === null
    && !archiveReadOnly && !active.providerFailure && active.state !== "failed"
    ? active.workspacePath
    : undefined
  const forkCheckpoint = snapshot.thread.filter((item) =>
    item.sessionId === active.id && item.kind === "checkpoint" && item.commit
  ).at(-1)
  const forkReason = forkSessionBlockedReason(active, forkCheckpoint)

  // The strip sits above the composer for a session you can drive, and above
  // the read-only notice for one you can only watch; the plan stays readable
  // either way, and only Edit and Discard shut.
  const planStrip = (
    <PlanStrip
      plan={snapshot.workingPlans.find((candidate) => candidate.sessionId === active.id)}
      readOnly={readOnly}
      {...(onEditPlan ? { onEditPlan: (edit: WorkingPlanEdit) => onEditPlan(active.id, edit) } : {})}
      {...(onDiscardPlanEdit ? { onDiscardEdit: (editId: string) => onDiscardPlanEdit(active.id, editId) } : {})}
      {...(onOpenPlanPreview ? { onOpenPreview: onOpenPlanPreview } : {})}
      className="mx-auto mb-2 max-w-[var(--shell-thread)]"
    />
  )

  const sendPrompt = async (nextPrompt: string, { fromComposer }: { fromComposer: boolean }, sendAttachments = attachments) => {
    if (watching) return
    setPending(true)
    setSendError("")
    try {
      const { selection, missing } = turnSkillSelectionFor(
        skillSelection,
        selectableSkills,
      )
      // Sending without them would quietly become a smaller selection, or an
      // explicit "no skills" if every chosen skill has gone.
      if (missing.length > 0) {
        setSendError(
          `${missing.length === 1 ? "A skill" : `${missing.length} skills`} you chose for this turn `
          + "is no longer in this project's catalog. Open Skills to review, then choose again.",
        )
        // A refusal must not swallow the message. Put it back where it was.
        if (!fromComposer) onQueuedChange({ sessionId: active.id, text: nextPrompt, state: "held", reason: "Held because the skills you chose are gone. Send it again when you have chosen." })
        return
      }
      // Empty the box now rather than after the round trip. The request budget is
      // 120 seconds, and the queue path already clears immediately, so waiting
      // made the interaction where less happened look like the faster one. Only
      // clear the box when the box is what was sent: a queued message released
      // while someone types would otherwise erase the new draft.
      if (fromComposer) {
        setPrompt("")
        setAttachments([])
        setSending(nextPrompt)
      }
      if (sendAttachments.length > 0) await onSend(active.id, nextPrompt, selection, sendAttachments)
      else await onSend(active.id, nextPrompt, selection)
      // The daemon accepted this selection, so it stops being a draft.
      setSkillSelection(undefined)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The message could not be sent")
      // Give the words back, but never over a newer thought. Waiting out a failed
      // send is exactly when someone starts typing the next one.
      if (fromComposer) {
        setPrompt((current) => current.length > 0 ? current : nextPrompt)
        setAttachments((current) => current.length > 0 ? current : [...sendAttachments])
      }
      // Held, not waiting: a refused message that re-queued itself would be
      // retried by the release effect on the very next render, forever.
      if (!fromComposer) onQueuedChange({ sessionId: active.id, text: nextPrompt, state: "held", reason: "Held because sending failed. Send it again when you want to retry." })
    } finally {
      setPending(false)
      setSending(null)
    }
  }

  // A message sent while a turn is running is queued, never sent on top of it
  // and never a reason to cancel it. One queued message, replaced rather than
  // stacked, and it leaves at the next turn boundary.
  const submitPrompt = async () => {
    if (pending || providerRestartRequired || emergencyStopPending || readOnly) return
    let submittedText = prompt
    if (prompt.trimStart().startsWith("/")) {
      const intent = slashIntent(prompt, slashContext)
      if (intent.kind === "invalid") {
        setSendError(intent.message)
        return
      }
      setSendError("")
      setSlashDismissed(true)
      switch (intent.kind) {
        case "mode":
          setPrompt("")
          if (runtimePending) return
          setRuntimePending(true)
          setRuntimeError("")
          try {
            await onSetRuntime(withPermissionMode(active.runtime, intent.permissionMode))
          } catch (cause) {
            setRuntimeError(cause instanceof Error ? cause.message : "The runtime could not be updated")
          } finally {
            setRuntimePending(false)
          }
          return
        case "revert":
          if (active.activeTurnId || restoreBusy) {
            setSendError(active.activeTurnId
              ? "Stop the active turn before restoring a checkpoint."
              : "Another checkpoint restore is already running.")
            return
          }
          setPrompt("")
          await restoreCheckpoint(intent.checkpointId)
          return
        case "skill":
          setSkillSelection(new Set([intent.skillId]))
          setPrompt("")
          return
        case "handoff":
          setTransferTargetId(intent.machineId)
          setPrompt("")
          return
        case "send":
          submittedText = intent.prompt
          break
      }
    }
    const outcome = submitFromComposer({
      text: submittedText,
      turnRunning: Boolean(active.activeTurnId),
      queued: queued?.sessionId === active.id ? queued.text : undefined,
    })
    if (outcome.action === "ignore") return
    if (outcome.action === "queue") {
      onQueuedChange({
        sessionId: active.id,
        text: outcome.text,
        state: "waiting",
        ...(skillSelection ? { skillIds: [...skillSelection] } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      setPrompt("")
      setAttachments([])
      setSkillSelection(undefined)
      return
    }
    await sendPrompt(outcome.text, { fromComposer: true })
  }

  const restartProvider = async () => {
    if (watching || !onRestartProviderThread || restartPending) return
    setRestartPending(true)
    setRestartError("")
    try {
      await onRestartProviderThread()
    } catch (cause) {
      setRestartError(cause instanceof Error ? cause.message : "The provider thread could not be restarted")
    } finally {
      setRestartPending(false)
    }
  }

  // When the daemon recorded the pause this client asked for, if it has.
  const stoppedAt = (() => {
    if (!stopped) return undefined
    const recorded = pauseRows(snapshot.thread, active.id).find((row) => !stopped.earlierPauseRows.has(row.id))
    return recorded ? new Date(recorded.createdAt) : undefined
  })()

  const pauseSession = async () => {
    if (watching || pending || !active.activeTurnId) return
    setPending(true)
    setSendError("")
    // Stopping is a refusal to run more work in this session. Without this the
    // queue would leave at the boundary the stop itself created.
    if (queued) onQueuedChange(heldAfter(queued, "Held because this session was stopped. Send it when you want it to run."))
    const turnId = active.activeTurnId
    const earlierPauseRows = new Set(pauseRows(snapshot.thread, active.id).map((row) => row.id))
    try {
      await onPauseSession(active.id)
      setStopped({ turnId, earlierPauseRows })
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The session could not be paused")
    } finally {
      setPending(false)
    }
  }

  // The machine on the other side of a move or a conflict, named rather than
  // shown as an id, when the fleet knows it.
  const otherMachineLabel = (() => {
    const otherId = active.state === "ownership-conflict"
      ? active.ownershipConflict?.otherMachineId
      : active.transfer?.targetMachineId
    if (otherId === undefined) return undefined
    return fleetMachines(fleet ?? []).find((machine) => machine.id === otherId)?.label
  })()

  const releaseSession = async (offer: SessionRecoveryOffer) => {
    if (watching || pending) return
    setPending(true)
    setRecoveryError("")
    try {
      await onReleaseSession?.({
        sessionId: active.id,
        transferId: offer.transferId,
        confirmation: offer.confirmation,
      })
    } catch (cause) {
      setRecoveryError(cause instanceof Error ? cause.message : "The session could not be released")
    } finally {
      setPending(false)
    }
  }

  const updateRuntime = async (runtime: Runtime) => {
    if (watching || runtimePending) return
    setRuntimePending(true)
    setRuntimeError("")
    const sessionId = active.id
    const previous = active.runtime
    // Only a level the previous model reported was ever on screen. A model
    // with no levels shows no chip, so moving off it drops nothing the person
    // saw, and the note would name a value they never chose.
    const previousShown = effortModel?.supportedReasoningEfforts.includes(previous.reasoning) ?? false
    try {
      await onSetRuntime(runtime)
      // As the design does: a model change sets or clears the note, a picked
      // level clears it, and a mode change leaves it.
      // A level carried by its shared word under another value did not move.
      const modelChanged = runtime.provider !== previous.provider || runtime.model !== previous.model
      const from = effortName(previous.provider, previous.reasoning)
      const to = effortName(runtime.provider, runtime.reasoning)
      if (modelChanged && previousShown && from !== to) {
        setEffortDropped({ sessionId, from, to })
      } else if (modelChanged || runtime.reasoning !== previous.reasoning) {
        setEffortDropped(undefined)
      }
    } catch (cause) {
      setRuntimeError(cause instanceof Error ? cause.message : "The runtime could not be updated")
    } finally {
      setRuntimePending(false)
    }
  }

  const effortModel = providerModels?.provider !== active.runtime.provider ? undefined : providerModels.models.find((model) => model.provider === active.runtime.provider && model.id === active.runtime.model)
  // The rule moves a level to the model's default whenever the model names
  // one among its levels, and to the nearest level only when it names none,
  // so the level sits on the model's default exactly when it moved there.
  // Read here from the session's model, because updateRuntime gets only the
  // new runtime and a harness switch's model is not in its model list.
  const effortDroppedHere = effortDropped?.sessionId === active.id && effortDropped.to === effortName(active.runtime.provider, active.runtime.reasoning)
    ? { from: effortDropped.from, to: effortDropped.to, toDefault: effortModel?.defaultReasoningEffort === active.runtime.reasoning }
    : undefined

  const forkRuntime = async (runtime: Runtime, checkpointId: string, requestId: string) => {
    if (watching || runtimePending || forkReason) return
    setRuntimePending(true)
    setRuntimeError("")
    try {
      await onForkSession({
        sessionId: active.id,
        checkpointId,
        runtime,
        requestId,
      })
    } catch (cause) {
      setRuntimeError(cause instanceof Error ? cause.message : "The session could not be forked")
      throw cause
    } finally {
      setRuntimePending(false)
    }
  }

  // Where a refusal goes is decided when it arrives. While its gate is still
  // pending, its card shows it, and it goes with the card when the gate leaves,
  // unless the gate was withdrawn in answer to it (the effect that places it
  // says how that is told apart). A refusal for a gate already gone (the
  // agent stopped waiting, the request was withdrawn or answered outside
  // Domovoi) has no card, so it shows with the composer's alerts.
  const cardShowsRefusal = Boolean(approval && !archiveReadOnly && approvalRefusal?.approvalId === approval.id)

  const resolveCurrentApproval = (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    explanation?: string,
  ) => {
    // One decision in flight at a time: until it is answered, no press reaches
    // this gate again or the next one drawn in its place. The ref holds it
    // between two clicks that land before a render.
    if (watching || resolvingApproval.current) return
    resolvingApproval.current = approval.id
    setResolvingApprovalId(approval.id)
    setSendError("")
    setApprovalRefusal(undefined)
    void onResolve(approval.id, decision, explanation, approval.revision).finally(() => {
      resolvingApproval.current = null
      setResolvingApprovalId(null)
    }).catch((cause: unknown) => {
      // The daemon answered and refused, a checkpoint it could not take
      // among the reasons: the gate card shows its words. Anything else,
      // such as a dropped connection, did not reach an answer and stays
      // with the composer's alerts.
      if (cause instanceof DaemonRpcError) {
        if (pendingApprovalIds.current.has(approval.id)) {
          setApprovalRefusal({ approvalId: approval.id, message: cause.message, arrivedAt: latestApprovalsKey.current })
        } else {
          setSendError(cause.message)
        }
        return
      }
      setSendError(cause instanceof Error ? cause.message : "The approval could not be resolved")
    })
  }

  return (
    <main className="flex h-full min-w-0 flex-col bg-background">
      {/* Shown once the stopped turn has ended, where the design draws its
          session notice: a strip above the thread. */}
      {stoppedAt && !active.activeTurnId ? <StoppedSessionNotice at={stoppedAt} /> : null}
      {freshWorktree ? <WorktreeReadyHeader workspacePath={freshWorktree} baseCommit={active.baseCommit} /> : null}
      <ScrollArea className="min-h-0 flex-1" viewportRef={threadViewport} onViewportScroll={follow.onScroll}>
        {/* One column with the composer: 24px of side padding inside the
            maximum leaves the content box at --shell-thread, the composer
            card's width. */}
        <div data-thread-column="" className="mx-auto flex w-full max-w-[calc(var(--shell-thread)+3rem)] flex-col gap-5 px-6 pt-6 pb-14">
          {freshWorktree ? <NothingHasRunYet runtime={active.runtime} /> : (
            <ThreadStartLine
              {...(snapshot.project ? { project: snapshot.project.name, branch: snapshot.project.branch } : {})}
              {...(active.workspacePath ? { workspacePath: active.workspacePath } : {})}
              {...(threadStartedAt ? { startedAt: threadStartedAt } : {})}
            />
          )}
          {active.state === "archived" ? <ArchivedSessionNotice session={active} /> : null}
          {providerRestartRequired ? (
            <FailedReadState
              message={active.providerFailure?.message ?? "The provider stopped answering before this session could be read completely."}
              facts={[
                active.providerFailure
                  ? providerFailureActionCopy(active.providerFailure)
                  : "The provider can be started again without replacing this session.",
                "The worktree and complete session history remain on this machine.",
                "Sending stays blocked until provider recovery succeeds.",
              ]}
              retrying={restartPending}
              retryDisabled={watching || !connected || onRestartProviderThread === undefined}
              retryError={restartError}
              onRetry={() => void restartProvider()}
            />
          ) : active.providerFailure ? (
            <Alert variant="destructive">
              <CircleStopIcon />
              <AlertTitle>{active.providerFailure.message}</AlertTitle>
              <AlertDescription>{providerFailureActionCopy(active.providerFailure)}</AlertDescription>
            </Alert>
          ) : null}
          {threadRows.map((row) => {
            if (row.kind === "activity") {
              // Between two calls no single call is in flight, but the turn
              // still is. The row at the end of a running thread is the one
              // the turn is working in.
              const rowRunning = Boolean(active.activeTurnId)
                && (row === lastRow || row.items.some((call) => call.outcome === "running"))
              // A running turn's file list is still growing, so naming files
              // mid-flight would show a total that keeps changing under the
              // reader. The chips wait for the turn to settle.
              const touched = rowRunning
                ? []
                : toolFileEntries(row.items.flatMap((call) => call.files ?? []))
              return (
                <Fragment key={row.id}>
                  <TurnActivity items={row.items} running={rowRunning} />
                  {touched.length > 0 ? <ThreadFileChips files={touched} onReview={onOpenSheet} /> : null}
                </Fragment>
              )
            }
            const item = row.item
            if (item.kind === "checkpoint") {
              return <CheckpointThreadItem key={item.id} item={item} disabled={pending || restoreBusy || readOnly || Boolean(active.activeTurnId)} onRestore={restoreCheckpointFromRow} />
            }
            if (item.kind === "user") {
              return (
                <div key={item.id} className="max-w-[82%] self-end rounded-xl border bg-card px-4 py-3">
                  <MarkdownQuickView source={item.body} />
                  <PromptDeliveryNote
                    delivery={item.providerPromptDelivery}
                    skillNames={skillNames ?? {}}
                  />
                </div>
              )
            }
            if (item.kind === "system" && item.notice === "context-compaction") {
              // A boundary in the transcript, not a notice about it. The reader
              // and the provider stop sharing history here, and the blue
              // system banner would both overstate one row and repeat itself
              // down a long session.
              return (
                <div key={item.id} data-testid="thread-compaction-marker" className="flex items-center gap-3 py-1 text-xs text-faint">
                  <span className="h-px flex-1 bg-border" />
                  <span className="shrink-0">
                    Context compacted. The provider stopped reading the turns above. Domovoi kept the thread above.
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )
            }
            if (item.kind === "system") {
              return <Alert key={item.id} className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"><BotIcon /><AlertTitle>System</AlertTitle><AlertDescription><MarkdownQuickView source={[item.body, item.detail].filter(Boolean).join("\n\n")} /></AlertDescription></Alert>
            }
            if (item.kind === "receipt") {
              return <ApprovalReceipt key={item.id} receipt={item} checkpointTaken={receiptCheckpointTaken(item, renderedThread)} />
            }
            if (item.kind === "policy-refusal") {
              return <PolicyRefusalCard key={item.id} refusal={item} />
            }
            if (item.kind === "tool") return null
            return <div key={item.id} className="flex max-w-2xl gap-3"><span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border bg-card text-primary"><DomovoiMark reduced className="size-4" /></span><MarkdownQuickView source={stripPlanTags(item.body)} /></div>
          })}
          {workingRow ? <TurnActivity items={[]} running /> : null}
          {transferReceipt ? (
            <Alert
              data-testid="session-transfer-receipt"
              className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"
            >
              <CheckIcon />
              <AlertTitle>{sessionTransferReceiptText(transferReceipt).title}</AlertTitle>
              <AlertDescription>{sessionTransferReceiptText(transferReceipt).detail}</AlertDescription>
            </Alert>
          ) : null}
          {approval && !archiveReadOnly ? <ApprovalCard key={approval.id} deciding={resolvingApprovalId !== null} surface={surface} approval={approval} watching={watching} connected={connected} refusal={cardShowsRefusal ? approvalRefusal?.message : undefined} onResolve={(decision, explanation) => resolveCurrentApproval(approval, decision, explanation)} /> : null}
        </div>
      </ScrollArea>
      {followPill ? (
        <div className="relative z-10 flex justify-center">
          <button
            type="button"
            onClick={follow.jumpToBottom}
            className={cn(
              "absolute bottom-1 flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11.5px] shadow-md transition-[filter] hover:brightness-110",
              follow.state === "gate" ? "border-warn-border bg-warn-background text-warn-foreground" : "border-border bg-card text-strong",
            )}
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", follow.state === "gate" ? "animate-pulse bg-warning" : "bg-primary")} />
            {followPill}
            <ArrowDownIcon className="size-3" />
          </button>
        </div>
      ) : null}
      <div className="relative z-[1] -mt-5 bg-[linear-gradient(to_bottom,transparent_0,color-mix(in_oklab,var(--background)_58%,transparent)_9px,var(--background)_20px)] px-6 py-5">
        {runtimeError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Runtime update failed</AlertTitle><AlertDescription>{runtimeError}</AlertDescription></Alert> : null}
        {sendError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Agent request failed</AlertTitle><AlertDescription>{sendError}</AlertDescription></Alert> : null}
        {recoveryError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Session could not be released</AlertTitle><AlertDescription>{recoveryError}</AlertDescription></Alert> : null}
        {planStrip}
        <ThreadComposer
          notice={watching ? (
            <div className="flex items-start gap-2.5 rounded-[calc(var(--radius)-2px)] border border-info-border bg-info-background px-3 py-[11px]">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] leading-[1.5] text-info-foreground">This device was paired to watch only.</div>
                <div className="mt-1 text-[11px] leading-[1.5] text-info-dim">No sends, approvals, terminal or writes. Reads stream as normal.</div>
              </div>
            </div>
          ) : archiveReadOnly ? (
            <SessionReadOnlyNotice
              session={active}
              otherLabel={otherMachineLabel}
              disabled={!connected || onReleaseSession === undefined}
              pending={pending}
              onRelease={(offer) => void releaseSession(offer)}
            />
          ) : null}
          failures={(failures ?? []).filter((attempt) => attempt.sessionId === active.id)}
          onQueuedChange={onQueuedChange}
          onDismissFailure={onDismissFailure}
          sending={sending}
          queued={queued?.sessionId === active.id ? queued : undefined}
          turnRunning={Boolean(active.activeTurnId)}
          pending={pending}
          connected={connected}
          readOnly={readOnly}
          watching={watching}
          emergencyStopPending={emergencyStopPending}
          providerRestartRequired={providerRestartRequired}
          surface={surface}
          {...(freshWorktree && snapshot.project ? { freshProject: snapshot.project.name } : {})}
          machineName={snapshot.machine.name}
          prompt={prompt}
          onPromptChange={setPrompt}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          slashOpen={slashOpen}
          slashContext={slashContext}
          onSlashDismissedChange={setSlashDismissed}
          onSubmit={() => void submitPrompt()}
          runtime={active.runtime}
          providers={snapshot.machine.providers}
          runtimePending={runtimePending}
          {...(forkCheckpoint ? { forkCheckpointId: forkCheckpoint.id } : {})}
          {...(forkReason ? { forkBlockedReason: forkReason } : {})}
          onListModels={onListModels}
          onDiscoverRuntime={onDiscoverRuntime}
          onRuntimeChange={(runtime) => void updateRuntime(runtime)}
          onFork={forkRuntime}
          effortModel={effortModel}
          effortDropped={effortDroppedHere}
          onOpenSheet={onOpenSheet}
          onOpenPromptEditor={() => setPromptEditorOpen(true)}
          usage={usage}
          usageToday={usageToday}
          loadLatestTurn={loadLatestTurn}
          onStop={() => void pauseSession()}
        >
          {/* v2 draws no machine control in the composer. The sessions
              drawer's "Move to another machine" opens this menu through
              openRequest, so its trigger stays mounted as the menu's anchor,
              inert and hidden from Tab and from assistive technology. */}
          {!readOnly ? (
            <div className="sr-only" aria-hidden inert>
              <MachineSwitcher
                entries={entries}
                openRequest={machineMenuRequest}
                triggerHidden
                onCloseAutoFocus={(event) => returnFocusFromMachineMenu(event, { dialog: false })}
                transferEntries={transferFleet}
                admittedMachines={admittedMachines}
                currentMachineId={currentMachineId ?? snapshot.machine.id}
                currentSessionCount={activeSessionCount(snapshot)}
                onPairMachine={onPairMachine ? () => setPairingMachine(true) : undefined}
                {...(onSelectMachine ? { onSelectMachine } : {})}
                {...(onTransferSession ? { onTransferSession: setTransferTargetId } : {})}
              />
            </div>
          ) : null}
          {!readOnly && onPairMachine ? (
            <PairMachineDialog
              open={pairingMachine}
              onOpenChange={setPairingMachine}
              onClaim={onPairMachine}
              onPaired={() => setPairingMachine(false)}
              onCloseAutoFocus={(event) => returnFocusFromMachineMenu(event, { dialog: true })}
            />
          ) : null}
          {!readOnly && onTransferSession && transferTarget ? (
            <TransferSessionDialog
              open
              onOpenChange={(open) => { if (!open) setTransferTargetId(null) }}
              session={active}
              source={sourceMachine}
              target={transferTarget}
              onTransfer={onTransferSession}
              onPreview={onPreviewTransfer!}
              onTransferred={(machineId) => {
                setTransferTargetId(null)
                onSelectMachine?.(machineId)
              }}
              onOutcome={(result) => setTransferReceipt({
                targetLabel: transferTarget.label,
                sourceLabel: sourceMachine.label,
                result,
              })}
              {...(onReleaseSession ? {
                onRecoverSource: (transferId: string) => onReleaseSession({
                  sessionId: active.id,
                  transferId,
                  confirmation: "target-does-not-have-session",
                }).then(() => undefined),
              } : {})}
              onCloseAutoFocus={(event) => returnFocusFromMachineMenu(event, { dialog: true })}
            />
          ) : null}
        </ThreadComposer>
        {!readOnly ? (
          <PromptEditorDialog
            open={promptEditorOpen}
            draft={prompt}
            pending={pending}
            sendDisabled={!prompt.trim() || providerRestartRequired || emergencyStopPending}
            onOpenChange={(open) => {
              setPromptEditorOpen(open)
              setEditorPasteNote("")
            }}
            onDraftChange={setPrompt}
            onSend={() => {
              setPromptEditorOpen(false)
              void submitPrompt()
            }}
            projectLabel={snapshot.project?.name ?? "No project"}
            {...(active.workspacePath ? { worktreeLabel: active.workspacePath.split(/[\\/]/u).at(-1) } : {})}
            turnRunning={Boolean(active.activeTurnId)}
            machineName={snapshot.machine.name}
            machineReachable={snapshot.machine.reachable}
            modelLabel={active.runtime.model}
            modeLabel={permissionModeLabel(active.runtime.permissionMode, active.runtime.auto).toLowerCase()}
            onPaste={(event) => {
              // The same draft as the composer, so the same conversion. The
              // file is drawn in the composer; the editor says where it went.
              const field = event.currentTarget
              const outcome = pasteOutcome(
                event.clipboardData.getData("text/plain"),
                attachments,
                field.value.length - (field.selectionEnd - field.selectionStart),
              )
              if (outcome.kind === "inline") {
                setEditorPasteNote(outcome.note ?? "")
                return
              }
              event.preventDefault()
              setAttachments((current) => [...current, outcome.attachment])
              setEditorPasteNote(`${attachmentName(outcome.attachment)} goes with the message as a file. The prompt carries its first ${desktopInlineLineLimit} lines.`)
            }}
            pasteNote={editorPasteNote || undefined}
          />
        ) : null}
      </div>
    </main>
  )
}

export type SessionTransferReceipt = {
  targetLabel: string
  sourceLabel: string
  result: SessionTransferResult
}

// A move is recorded in the thread whichever way it went, and a refusal says
// what the daemon refused it for rather than a generic failure.
export function sessionTransferReceiptText(receipt: SessionTransferReceipt): {
  title: string
  detail: string
} {
  if (receipt.result.outcome === "succeeded") {
    return {
      title: `Session moved to ${receipt.targetLabel}`,
      detail: `Checkpoint ${receipt.result.checkpointCommit.slice(0, 12)} · ${receipt.sourceLabel} keeps a recovery checkpoint`,
    }
  }
  return {
    title: `Session did not move to ${receipt.targetLabel}`,
    detail: receipt.result.outcome === "refused"
      ? sessionTransferRefusalMessage(receipt.result.reason)
      : `The transfer did not finish and the session stayed on ${receipt.sourceLabel}`,
  }
}
