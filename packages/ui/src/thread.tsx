import { useEffect, useRef, useState } from "react"
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  CircleStopIcon,
  FolderOpenIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  SendIcon,
} from "lucide-react"
import type {
  ApprovalRequest,
  ApprovalDecision,
  ProviderFailure,
  ProviderModel,
  RpcParams,
  Runtime,
  FleetEntry,
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
  TurnSkillSelectionRefusal,
  ThreadItem,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { selectableTurnSkills, sessionTransferRefusalMessage, turnSkillRefusalFrom, turnSkillSelectionFor } from "@getdomovoi/protocol"
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
import { Input } from "./components/ui/input"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { Textarea } from "./components/ui/textarea"
import { MachineSwitcher } from "./machine-switcher.js"
import { fleetMachines } from "./fleet-entries.js"
import { PairMachineDialog } from "./pair-machine-dialog.js"
import { TransferSessionDialog } from "./transfer-session-dialog.js"
import type { PairedMachine, PairMachineRequest } from "./pair-machine.js"
import { cn } from "./lib/utils"
import { DomovoiMark } from "./domovoi-mark"
import { ComposerSkillChip } from "./composer-skills"
import { ApprovalReceipt } from "./approval-receipt"
import { PlanStrip } from "./plan-strip"
import { ModelPopover } from "./model-popover.js"
import { ModeChip, ThinkChip, type ReasoningCatalog } from "./mode-chip.js"
import type { WorkingPlanEdit } from "./plan-step-editor.js"
import { groupThreadActivity } from "./thread-activity-groups"
import { TurnActivity } from "./turn-activity"
import { CheckpointRestore, checkpointBlockedReason, checkpointRestoreBlocked } from "./checkpoint-actions.js"
import { UsageChip } from "./usage-chip.js"
import {
  deliveryLabel,
  heldAfter,
  submitFromComposer,
  type FailedAttempt,
  type QueuedMessage,
} from "./turn-queue"
import { PromptDeliveryNote } from "./prompt-delivery-note"
import { providerCanStartSession, providerDisplayName, reasoningOptionsFor } from "./runtime"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { MarkdownQuickView } from "./markdown-quick-view"
import { PromptEditorDialog } from "./prompt-editor"
import { desktopExternalActionLabel, type DesktopExternalEditor } from "./desktop-platform"
import {
  activeSessionCount,
  forkSessionBlockedReason,
  localFleetEntry,
  localMachineEntry,
  renderedThreadForActiveSession,
  sessionIsArchiveReadOnly,
} from "./workspace-selectors"
import { restoreFocusAfterUpdate } from "./restore-focus"

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


function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest
  onResolve: (
    decision: ApprovalDecision,
    explanation?: string,
  ) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const explainTriggerRef = useRef<HTMLButtonElement>(null)
  const [explainOpen, setExplainOpen] = useState(false)
  const [explanation, setExplanation] = useState("")
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "end" })
  }, [approval.id])

  // Agent and mode ride the header line instead of the grid, the way the design
  // system draws the gate. Nothing is dropped: a desktop shows every fact.
  const facts = [
    ["Machine", approval.machine],
    ["Directory", approval.directory],
    ["Affects", approval.affects],
    ["Network", approval.network],
    ["Est. duration", approval.estimatedDuration],
  ]
  const closeExplanation = () => {
    setExplainOpen(false)
    setExplanation("")
    restoreFocusAfterUpdate(explainTriggerRef)
  }

  return (
    <Alert ref={cardRef} variant="warning" className="mx-auto max-w-3xl gap-3 rounded-xl p-4">
      <CircleStopIcon />
      <AlertTitle className="flex items-center gap-2 text-[12.5px]">
        Approval required
        {approval.risk === "hard-gate" ? <Badge variant="warning">Hard gate</Badge> : null}
        <span className="ml-auto font-machine text-[10.5px] font-normal text-warn-dim">
          {approval.agent} · {approval.mode}
        </span>
      </AlertTitle>
      <AlertDescription className="col-span-full flex flex-col gap-3">
        <p className="text-[13px] font-medium text-warn-foreground">{approval.operation}</p>
        <code className="break-all whitespace-pre-wrap rounded-md bg-warn-deep px-3 py-2 font-machine text-[11px] text-warn-foreground">
          {approval.command}
        </code>
        <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          {facts.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-warn-dim">{label}</dt>
              <dd className="m-0 min-w-0 break-words font-machine text-warn-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {explainOpen ? (
          <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-background/40 p-3">
            <label htmlFor={`denial-${approval.id}`} className="text-[11px] font-medium text-warn-foreground">
              Tell the agent why this command was denied
            </label>
            <Input
              id={`denial-${approval.id}`}
              autoFocus
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  event.stopPropagation()
                  closeExplanation()
                  return
                }
                if (event.key === "Enter" && explanation.trim()) {
                  onResolve("deny-explain", explanation.trim())
                }
              }}
              placeholder="Explain what should change before retrying"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeExplanation}>Cancel</Button>
              <Button
                variant="warning"
                size="sm"
                disabled={!explanation.trim()}
                onClick={() => onResolve("deny-explain", explanation.trim())}
              >
                Deny with explanation
              </Button>
            </div>
          </div>
        ) : null}
        {/* One decision at full weight, two outlined beside it, and the fourth
            as plain text. Four peer buttons make a person read all four before
            the gate can move. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="warning" size="sm" onClick={() => onResolve("allow-once")}>Allow once</Button>
          <Button variant="outline" size="sm" onClick={() => onResolve("always-project")}>Always in this project</Button>
          <Button variant="outline" size="sm" onClick={() => onResolve("deny")}>Deny</Button>
          <button
            ref={explainTriggerRef}
            type="button"
            onClick={() => setExplainOpen(true)}
            className="ml-auto rounded-sm text-[11px] text-warn-dim underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warning"
          >
            Deny and explain
          </button>
        </div>
      </AlertDescription>
    </Alert>
  )
}


export function CheckpointThreadItem({
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
}

export const archiveSessionDescription = "Domovoi creates a final checkpoint, stops provider and terminal resources, and removes the isolated session worktree. Durable history, checkpoint refs, artifact and annotation records, audit refs, and the archive branch are retained. The source checkout's branch, HEAD, status, and files remain unchanged."

export function ArchiveSessionAction({
  disabled,
  onArchive,
}: {
  disabled: boolean
  onArchive: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <ArchiveIcon data-icon="inline-start" />
          Archive session
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this session?</AlertDialogTitle>
          <AlertDialogDescription>
            {archiveSessionDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onArchive}>Archive session</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  onCheckpoint,
  onRestoreCheckpoint,
  restoreBusy = false,
  pendingTransferTargetId = null,
  onPendingTransferTargetChange,
  onPauseSession,
  onArchiveSession,
  onOpenExternal,
  onPairMachine,
  onSelectMachine,
  onTransferSession,
  onPreviewTransfer,
  onReleaseSession,
  externalEditor = "system",
  usage = null,
  usageToday = null,
  loadLatestTurn,
  onDiscoverRuntime,
  onEditPlan,
  onDiscardPlanEdit,
  onOpenPlanPreview,
  machineMenuRequest,
  onOpenSkills,
  skillNames,
  skillCatalog,
}: {
  snapshot: WorkspaceSnapshot
  connected: boolean
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
  onResolve: (
    approvalId: string,
    decision: ApprovalDecision,
    explanation?: string,
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
  ) => Promise<void>
  onCheckpoint: (sessionId: string) => Promise<void>
  onRestoreCheckpoint: (sessionId: string, checkpointId: string) => Promise<void>
  // Set while a restore started anywhere in the shell is still running.
  restoreBusy?: boolean
  // A transfer target named outside the thread, by the launcher.
  pendingTransferTargetId?: string | null | undefined
  onPendingTransferTargetChange?: ((machineId: string | null) => void) | undefined
  onPauseSession: (sessionId: string) => Promise<void>
  onArchiveSession: (sessionId: string) => Promise<void>
  onOpenExternal?: ((path: string) => Promise<void>) | undefined
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
  externalEditor?: DesktopExternalEditor | undefined
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
  // Bumped by the sessions drawer's "Move to another machine" so the composer's
  // machine menu opens on the session it just activated.
  machineMenuRequest?: number | undefined
  onOpenSkills?: (() => void) | undefined
  skillNames?: Record<string, string> | undefined
  skillCatalog?: readonly SkillSummary[] | undefined
}) {
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)
  const approval = active
    ? snapshot.approvals.find((candidate) => candidate.sessionId === active.id)
    : undefined
  const [prompt, setPrompt] = useState("")
  const [skillSelection, setSkillSelection] = useState<ReadonlySet<string> | undefined>(undefined)
  const [skillRefusal, setSkillRefusal] = useState<TurnSkillSelectionRefusal | undefined>(undefined)
  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  const [pairingMachine, setPairingMachine] = useState(false)
  const [ownTransferTargetId, setOwnTransferTargetId] = useState<string | null>(null)
  // The composer's machine menu and the launcher both name a target. The shell
  // owns it when it supplies one, so either route reaches the same dialog.
  const transferTargetId = pendingTransferTargetId ?? ownTransferTargetId
  const setTransferTargetId = (machineId: string | null) => {
    setOwnTransferTargetId(machineId)
    onPendingTransferTargetChange?.(machineId)
  }
  const [transferReceipt, setTransferReceipt] = useState<SessionTransferReceipt | null>(null)
  const [pending, setPending] = useState(false)
  const [runtimePending, setRuntimePending] = useState(false)
  const [sendError, setSendError] = useState("")
  const [recoveryError, setRecoveryError] = useState("")
  const [runtimeError, setRuntimeError] = useState("")
  const [restartPending, setRestartPending] = useState(false)
  const [desktopError, setDesktopError] = useState("")
  // The Think chip offers what the current model reports. The catalog is read
  // once per provider change; a read that fails leaves the chip shut with its
  // reason rather than offering a guess. Hooks sit above the no-session return.
  const activeProvider = active?.runtime.provider
  const [catalog, setCatalog] = useState<{ status: "loading" } | { status: "ready", models: ProviderModel[] } | { status: "failed", message: string }>({ status: "loading" })
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  useEffect(() => {
    if (!activeProvider) return
    let live = true
    setCatalog({ status: "loading" })
    void onListModels(activeProvider).then(
      (models) => { if (live) setCatalog({ status: "ready", models }) },
      (cause: unknown) => { if (live) setCatalog({ status: "failed", message: cause instanceof Error ? cause.message : "Models could not be loaded" }) },
    )
    return () => { live = false }
  }, [onListModels, activeProvider, catalogAttempt])
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
            <Button onClick={onNewSession}>
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
  const reasoningCatalog: ReasoningCatalog = catalog.status === "ready"
    ? { status: "ready", options: reasoningOptionsFor(catalog.models.find((model) => model.provider === active.runtime.provider && model.id === active.runtime.model)) }
    : catalog
  const providerReady = snapshot.machine.providers.some((provider) => provider.id === active.runtime.provider && providerCanStartSession(provider))

  const checkpointReason = checkpointBlockedReason(active.activeTurnId)
  const archiveReadOnly = sessionIsArchiveReadOnly(active)
  const providerRestartRequired = active.state === "failed" && !active.providerThreadId
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
      readOnly={archiveReadOnly}
      {...(onEditPlan ? { onEditPlan: (edit: WorkingPlanEdit) => onEditPlan(active.id, edit) } : {})}
      {...(onDiscardPlanEdit ? { onDiscardEdit: (editId: string) => onDiscardPlanEdit(active.id, editId) } : {})}
      {...(onOpenPlanPreview ? { onOpenPreview: onOpenPlanPreview } : {})}
      className="mx-auto mb-2 max-w-[var(--shell-thread)]"
    />
  )

  const sendPrompt = async (nextPrompt: string, { fromComposer }: { fromComposer: boolean }) => {
    setPending(true)
    setSendError("")
    setSkillRefusal(undefined)
    try {
      const { selection, missing } = turnSkillSelectionFor(
        skillSelection,
        selectableTurnSkills(skillCatalog ?? [], snapshot.skillEnablements, snapshot.project?.id),
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
      await onSend(active.id, nextPrompt, selection)
      // Only clear the box when the box is what was sent. A queued message
      // released while someone types would otherwise erase the new draft.
      if (fromComposer) setPrompt("")
      // The daemon accepted this selection, so it stops being a draft.
      setSkillSelection(undefined)
    } catch (cause) {
      const refusal = turnSkillRefusalFrom(cause)
      if (refusal) setSkillRefusal(refusal)
      setSendError(cause instanceof Error ? cause.message : "The message could not be sent")
      // Held, not waiting: a refused message that re-queued itself would be
      // retried by the release effect on the very next render, forever.
      if (!fromComposer) onQueuedChange({ sessionId: active.id, text: nextPrompt, state: "held", reason: "Held because sending failed. Send it again when you want to retry." })
    } finally {
      setPending(false)
    }
  }

  // A message sent while a turn is running is queued, never sent on top of it
  // and never a reason to cancel it. One queued message, replaced rather than
  // stacked, and it leaves at the next turn boundary.
  const submitPrompt = async () => {
    if (pending || providerRestartRequired || emergencyStopPending) return
    const outcome = submitFromComposer({
      text: prompt,
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
      })
      setPrompt("")
      return
    }
    await sendPrompt(outcome.text, { fromComposer: true })
  }

  const restartProvider = async () => {
    if (!onRestartProviderThread || restartPending) return
    setRestartPending(true)
    setSendError("")
    try {
      await onRestartProviderThread()
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The provider thread could not be restarted")
    } finally {
      setRestartPending(false)
    }
  }

  const createCheckpoint = async () => {
    if (pending || checkpointReason) return
    setPending(true)
    setSendError("")
    try {
      await onCheckpoint(active.id)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The checkpoint could not be created")
    } finally {
      setPending(false)
    }
  }

  const restoreCheckpoint = async (checkpointId: string) => {
    if (checkpointRestoreBlocked(pending, archiveReadOnly)) return
    setPending(true)
    setSendError("")
    try {
      await onRestoreCheckpoint(active.id, checkpointId)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The checkpoint could not be restored")
    } finally {
      setPending(false)
    }
  }

  const pauseSession = async () => {
    if (pending || !active.activeTurnId) return
    setPending(true)
    setSendError("")
    // Stopping is a refusal to run more work in this session. Without this the
    // queue would leave at the boundary the stop itself created.
    if (queued) onQueuedChange(heldAfter(queued, "Held because this session was stopped. Send it when you want it to run."))
    try {
      await onPauseSession(active.id)
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
    if (pending) return
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

  const archiveSession = async () => {
    if (pending || archiveReadOnly) return
    setPending(true)
    setSendError("")
    try {
      await onArchiveSession(active.id)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The session could not be archived")
    } finally {
      setPending(false)
    }
  }

  const openExternal = async () => {
    if (!active.workspacePath || !onOpenExternal) return
    setDesktopError("")
    try {
      await onOpenExternal(active.workspacePath)
    } catch (cause) {
      setDesktopError(cause instanceof Error ? cause.message : "External editor could not open the worktree")
    }
  }

  const updateRuntime = async (runtime: Runtime) => {
    if (runtimePending) return
    setRuntimePending(true)
    setRuntimeError("")
    try {
      await onSetRuntime(runtime)
    } catch (cause) {
      setRuntimeError(cause instanceof Error ? cause.message : "The runtime could not be updated")
    } finally {
      setRuntimePending(false)
    }
  }

  const forkRuntime = async (runtime: Runtime, checkpointId: string, requestId: string) => {
    if (runtimePending || forkReason) return
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

  const resolveCurrentApproval = (
    approvalId: string,
    decision: ApprovalDecision,
    explanation?: string,
  ) => {
    setSendError("")
    void onResolve(approvalId, decision, explanation).catch((cause: unknown) => {
      setSendError(cause instanceof Error ? cause.message : "The approval could not be resolved")
    })
  }

  return (
    <main className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex min-h-[76px] flex-wrap items-start justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 max-w-xl text-[17px] leading-[1.25] font-semibold tracking-[-0.01em]">
            {active.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-machine text-[10px] text-faint">
            {active.workspacePath ? <span>{active.workspacePath}</span> : null}
            {active.baseCommit && snapshot.project ? <span>from {snapshot.project.branch} @ {active.baseCommit.slice(0, 8)}</span> : null}
            <span>{active.changedFiles} files</span>
            <span className="text-success">{active.testsPassed} pass</span>
            {active.testsFailed ? <span className="text-destructive">{active.testsFailed} fail</span> : null}
          </div>
        </div>
        {archiveReadOnly ? (
          <Badge variant="outline">
            {readOnlySessionNotice(active, otherMachineLabel)?.badge ?? "Read-only"}
          </Badge>
        ) : (
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
            {active.workspacePath && onOpenExternal ? (
              <Button variant="outline" size="sm" onClick={() => void openExternal()}>
                <ExternalLinkIcon data-icon="inline-start" />
                {desktopExternalActionLabel(externalEditor)}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[668px] flex-col gap-5 px-6 py-6">
          {active.providerFailure ? (
            <Alert variant="destructive">
              <CircleStopIcon />
              <AlertTitle>{active.providerFailure.message}</AlertTitle>
              <AlertDescription>{providerFailureActionCopy(active.providerFailure)}</AlertDescription>
            </Alert>
          ) : null}
          {providerRestartRequired ? (
            <Alert variant="destructive">
              <CircleStopIcon />
              <AlertTitle>Provider thread needs recovery</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-3">
                The worktree and session history are safe. Restart the provider before sending another message.
                <Button variant="outline" size="sm" disabled={!connected || restartPending} onClick={() => void restartProvider()}>
                  {restartPending ? "Restarting provider…" : "Restart provider"}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {groupThreadActivity(renderedThreadForActiveSession(snapshot)).map((row) => {
            if (row.kind === "activity") {
              return (
                <TurnActivity
                  key={row.id}
                  items={row.items}
                  running={Boolean(active.activeTurnId) && row.items.some((call) => call.outcome === "running")}
                />
              )
            }
            const item = row.item
            if (item.kind === "checkpoint") {
              return <CheckpointThreadItem key={item.id} item={item} disabled={pending || restoreBusy || archiveReadOnly || Boolean(active.activeTurnId)} onRestore={(checkpointId) => void restoreCheckpoint(checkpointId)} />
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
            if (item.kind === "system") {
              return <Alert key={item.id} className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"><BotIcon /><AlertTitle>System</AlertTitle><AlertDescription><MarkdownQuickView source={[item.body, item.detail].filter(Boolean).join("\n\n")} /></AlertDescription></Alert>
            }
            if (item.kind === "receipt") {
              return <ApprovalReceipt key={item.id} receipt={item} />
            }
            // Grouping consumed every tool item, so nothing reaches here.
            if (item.kind === "tool") return null
            return <div key={item.id} className="flex max-w-2xl gap-3"><span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border bg-card text-primary"><DomovoiMark reduced className="size-4" /></span><MarkdownQuickView source={item.body} /></div>
          })}
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
          {approval && !archiveReadOnly ? <ApprovalCard approval={approval} onResolve={(decision, explanation) => resolveCurrentApproval(approval.id, decision, explanation)} /> : null}
        </div>
      </ScrollArea>
      {archiveReadOnly ? (
        <div className="px-5 py-3">
          {planStrip}
          {recoveryError ? (
            <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]">
              <CircleStopIcon />
              <AlertTitle>Session could not be released</AlertTitle>
              <AlertDescription>{recoveryError}</AlertDescription>
            </Alert>
          ) : null}
          <SessionReadOnlyNotice
            session={active}
            otherLabel={otherMachineLabel}
            disabled={!connected || onReleaseSession === undefined}
            pending={pending}
            onRelease={(offer) => void releaseSession(offer)}
          />
        </div>
      ) : <div className="px-5 py-3 [mask-image:linear-gradient(to_bottom,transparent_0,black_12px)]">
        {desktopError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Desktop action failed</AlertTitle><AlertDescription>{desktopError}</AlertDescription></Alert> : null}
        {runtimeError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Runtime update failed</AlertTitle><AlertDescription>{runtimeError}</AlertDescription></Alert> : null}
        {sendError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Agent request failed</AlertTitle><AlertDescription>{sendError}</AlertDescription></Alert> : null}
        {planStrip}
        <div className="mx-auto flex max-w-[var(--shell-thread)] flex-col gap-2 rounded-xl border bg-card p-3">
          {(failures ?? []).filter((attempt) => attempt.sessionId === active.id).map((attempt) => (
            <div key={attempt.id} className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-background px-3 py-2">
              <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-danger-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-danger-foreground">{attempt.text}</span>
              <span className="text-[10.5px] whitespace-nowrap text-danger-dim">{deliveryLabel(attempt)}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Queueing it again replaces whatever is waiting, which the
                  // person can see beside it before they press.
                  onQueuedChange({
                    sessionId: attempt.sessionId,
                    text: attempt.text,
                    state: "waiting",
                    ...(attempt.skillIds ? { skillIds: attempt.skillIds } : {}),
                  })
                  onDismissFailure?.(attempt.id)
                }}
              >
                {attempt.delivery === "refused" ? "Queue again" : "Send anyway"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onDismissFailure?.(attempt.id)}>Dismiss</Button>
            </div>
          ))}
          {queued?.sessionId === active.id ? (
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
              <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-faint" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-strong">{queued.text}</span>
              <span className="font-machine text-[10.5px] whitespace-nowrap text-faint">
                {queued.state === "held" ? queued.reason ?? "held" : "sends at the next turn boundary"}
              </span>
              {queued.state === "held" ? (
                <Button variant="ghost" size="sm" disabled={Boolean(active.activeTurnId) || pending || emergencyStopPending || providerRestartRequired} onClick={() => onQueuedChange({ ...queued, state: "waiting" })}>Send</Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => onQueuedChange(undefined)}>Remove</Button>
            </div>
          ) : null}
          <Textarea
            aria-label="Message"
            rows={2}
            className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            placeholder={active.activeTurnId ? "Send to queue for the next turn" : "Message the agent"}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void submitPrompt()
              }
            }}
          />
          <div data-workspace-composer-actions="" className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {/* v2's model chip leads the composer's action row and opens the
                  flat, searchable list of what every harness here reports. */}
              <ModelPopover
                runtime={active.runtime}
                providers={snapshot.machine.providers}
                machineName={snapshot.machine.name}
                pending={runtimePending}
                turnRunning={Boolean(active.activeTurnId)}
                {...(forkCheckpoint ? { forkCheckpointId: forkCheckpoint.id } : {})}
                {...(forkReason ? { forkBlockedReason: forkReason } : {})}
                onListModels={onListModels}
                onDiscoverRuntime={onDiscoverRuntime}
                onChange={(runtime) => void updateRuntime(runtime)}
                onFork={forkRuntime}
              />
              {/* v2's mode chip sits beside the model. Think has no drawing in
                  v2; the runtime carries it, so it stays as a plain chip here. */}
              <ModeChip runtime={active.runtime} pending={runtimePending} onSetRuntime={(runtime) => void updateRuntime(runtime)} />
              <ThinkChip runtime={active.runtime} catalog={reasoningCatalog} pending={runtimePending} onSetRuntime={(runtime) => void updateRuntime(runtime)} onRetry={() => setCatalogAttempt((attempt) => attempt + 1)} />
              {!providerReady ? <Badge variant="outline" className="text-warning">{providerDisplayName(active.runtime.provider)} not ready</Badge> : null}
              {onOpenSkills ? (
                <ComposerSkillChip
                  snapshot={snapshot}
                  skillNames={skillNames ?? {}}
                  onOpenSkills={onOpenSkills}
                  selection={skillSelection}
                  onSelectionChange={setSkillSelection}
                  refusal={skillRefusal}
                />
              ) : null}
              <MachineSwitcher
                entries={entries}
                openRequest={machineMenuRequest}
                transferEntries={transferFleet}
                admittedMachines={admittedMachines}
                currentMachineId={currentMachineId ?? snapshot.machine.id}
                currentSessionCount={activeSessionCount(snapshot)}
                onPairMachine={onPairMachine ? () => setPairingMachine(true) : undefined}
                {...(onSelectMachine ? { onSelectMachine } : {})}
                {...(onTransferSession ? { onTransferSession: setTransferTargetId } : {})}
              />
              {onPairMachine ? (
                <PairMachineDialog
                  open={pairingMachine}
                  onOpenChange={setPairingMachine}
                  onClaim={onPairMachine}
                  onPaired={() => setPairingMachine(false)}
                />
              ) : null}
              {onTransferSession && transferTarget ? (
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
                />
              ) : null}
              <Button variant="ghost" size="sm" disabled={pending || Boolean(checkpointReason)} title={checkpointReason} onClick={() => void createCheckpoint()}>Checkpoint</Button>
              {checkpointReason ? <span role="status" className="font-machine text-mono-xs text-faint">{checkpointReason}</span> : null}
              {active.activeTurnId ? <Button variant="ghost" size="sm" disabled={pending || !connected} onClick={() => void pauseSession()}><CircleStopIcon data-icon="inline-start" />Stop</Button> : null}
              <ArchiveSessionAction disabled={pending || !connected} onArchive={() => void archiveSession()} />
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* v2's usage chip belongs to the composer, at the right of its
                  action row. The sidebar reorganisation moves the row with it. */}
              <UsageChip usage={usage} today={usageToday} loadLatestTurn={loadLatestTurn} />
              <span role="status" className="font-machine text-mono-xs text-faint">{providerRestartRequired ? "Restart the provider before sending" : "Ctrl/⌘ + Enter send"}</span><Button variant="ghost" size="icon-sm" aria-label="Expand prompt editor" onClick={() => setPromptEditorOpen(true)}><Maximize2Icon /></Button><Button size="icon-sm" aria-label="Send message" disabled={!prompt.trim() || pending || providerRestartRequired || emergencyStopPending} onClick={() => void submitPrompt()}><SendIcon /></Button></div>
          </div>
        </div>
        <PromptEditorDialog
          open={promptEditorOpen}
          draft={prompt}
          pending={pending}
          sendDisabled={!prompt.trim() || providerRestartRequired || emergencyStopPending}
          onOpenChange={setPromptEditorOpen}
          onDraftChange={setPrompt}
          onSend={() => {
            setPromptEditorOpen(false)
            void submitPrompt()
          }}
          projectLabel={snapshot.project?.name ?? "No project"}
          {...(active.workspacePath ? { worktreeLabel: active.workspacePath.split(/[\\/]/u).at(-1) } : {})}
        />
      </div>}
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
