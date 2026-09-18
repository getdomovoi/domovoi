import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  FolderOpenIcon,
  ExternalLinkIcon,
  MinusIcon,
  SearchIcon,
  Maximize2Icon,
  SendIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import type {
  ApprovalRequest,
  ApprovalDecision,
  ClientKind,
  PermissionMode,
  ProviderFailure,
  ProviderModel,
  ProjectSwitchConfirmation,
  RpcParams,
  Runtime,
  FleetEntry,
  SessionSummary,
  SessionTransferParams,
  SessionTransferResult,
  SkillSummary,
  SkillInventorySource,
  SessionTransferPreview,
  SessionTransferPreviewParams,
  SessionUsage,
  SessionTurn,
  RuntimeDiscoverResult,
  UsageWindow,
  UsageWindowParams,
  TurnSkillSelection,
  TurnSkillSelectionRefusal,
  SystemEmergencyStopResult,
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
import { WorkspaceConnectionStatus } from "./connection-status"
import { Input } from "./components/ui/input"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable"
import { ScrollArea } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { Textarea } from "./components/ui/textarea"
import { MachineSwitcher } from "./machine-switcher.js"
import { fleetMachines } from "./fleet-entries.js"
import { machineAttachment } from "./machine-selection.js"
import { PairMachineDialog } from "./pair-machine-dialog.js"
import { TransferSessionDialog } from "./transfer-session-dialog.js"
import type { PairedMachine, PairMachineRequest } from "./pair-machine.js"
import { TooltipProvider } from "./components/ui/tooltip"
import { cn } from "./lib/utils"
import { DaemonRpcError, ProjectSwitchConfirmationError } from "./client"
import { SessionsDrawerColumn, SessionsDrawerTrigger, type SessionRowAction } from "./sessions-drawer"
import { useWorkspace } from "./use-workspace"
import type { RelayPinStorage } from "./relay-pin"
import { FleetAccessSession } from "./fleet-access-session"
import { ClientAdmissionError } from "./client-admission-policy"
import { prepareFleetEndpoint, withinFleetDeadline } from "./fleet-access"
import { Deadline } from "./deadline"
import { collectFleetInventories } from "./fleet-inventories"
import { DomovoiMark } from "./domovoi-mark"
import { StopMenu } from "./stop-menu"
import {
  sessionUsageFetchKey,
  usageTodayRefreshDelayMs,
  usageTodayWindow,
  usageWindowFetchKey,
} from "./session-usage"
import { SkillBrowser } from "./skill-browser"
import { AuditLogView } from "./audit-log-view"
import { FleetView } from "./fleet-view"
import { type ProviderSecretStatus } from "./provider-settings"
import { SettingsShell, type LocalDaemonDescription } from "./settings-shell"
import { SessionListSkeleton, ThreadSkeleton } from "./loading-skeleton"
import { WorkspaceRail } from "./workspace-rail"
import { ComposerSkillChip } from "./composer-skills"
import { MachineSheet } from "./machine-sheet"
import { ApprovalReceipt } from "./approval-receipt"
import { PlanStrip } from "./plan-strip"
import { ModelPopover } from "./model-popover.js"
import { ModeChip, ThinkChip, type ReasoningCatalog } from "./mode-chip.js"
import type { WorkingPlanEdit } from "./plan-step-editor.js"
import { groupThreadActivity } from "./thread-activity-groups"
import { TurnActivity } from "./turn-activity"
import { withPermissionMode } from "./permission-mode"
import { CheckpointFork, CheckpointRestore, CheckpointRestoreAction, checkpointBlockedReason, checkpointRestoreBlocked } from "./checkpoint-actions.js"
import { UsageChip, latestTurnFromHistory } from "./usage-chip.js"
import { deliveryLabel, failedAttempt, heldAfter, holdAllAfterStop, provesNothingRan, releasableQueues, setQueue, submitFromComposer, type FailedAttempt, type QueuedMessage, type SessionQueues } from "./turn-queue"
import { PromptDeliveryNote } from "./prompt-delivery-note"
import { notificationPreferenceFor, type NotificationPreferences } from "./notification-preferences"
import {
  DesktopFirstRunDialog,
  desktopFirstRunAvailable,
  firstRunFailureForProvider,
  providerFirstRunRecovery,
} from "./desktop-first-run"
import {
  browserDesktopFirstRunStorage,
  completeDesktopFirstRun,
  defaultDesktopFirstRunState,
  loadDesktopFirstRunState,
  resetDesktopFirstRunState,
  saveDesktopFirstRunState,
  type DesktopFirstRunState,
} from "./desktop-first-run-persistence"
import { preferredSessionProvider, providerCanStartSession, providerDisplayName, reasoningOptionsFor } from "./runtime"
import type { TerminalControls } from "./terminal-pane"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { MarkdownQuickView } from "./markdown-quick-view"
import {
  browserWorkspaceUiStorage,
  loadWorkspaceUiState,
  reconcileWorkspaceUiState,
  saveWorkspaceUiState,
  type WorkspaceSurface,
} from "./workspace-persistence"
import {
  buildWorkspaceCommands,
  commandPaletteShortcut,
  CommandPalette,
  type CommandPalettePlatform,
} from "./command-palette"
import { useAppearanceTheme, type WorkspaceTheme } from "./appearance"
import { PromptEditorDialog } from "./prompt-editor"
import { WorkspaceNotificationTracker, type DesktopNotificationRequest } from "./desktop-notifications"
import {
  copyDesktopText,
  desktopExternalActionLabel,
  enqueueDesktopDeepLink,
  openDesktopPath,
  openProjectFromDesktop,
  type DesktopExternalEditor,
  type DesktopWindowBridge,
  type WorkspaceWindowDecoration,
} from "./desktop-platform"
import type {
  WorkspaceInstallState,
  WorkspaceNotificationDelivery,
  WorkspacePlatform,
} from "./workspace-platform"
import { ArtifactDock, DockRail } from "./artifact-dock"
import { activeSession, activeSessionCount, activeThreadKey, forkSessionBlockedReason, localFleetEntry, localMachineEntry, renderedThreadForActiveSession, sessionIsArchiveReadOnly } from "./workspace-selectors"
import { LauncherDialog, type LauncherMode, ProjectSwitchConfirmationDialog } from "./launcher-dialog"

export { LauncherDialog, ProjectSwitchConfirmationDialog, ProviderReadinessList } from "./launcher-dialog"

export { activeSession, activeSessionCount, activeThreadKey, forkSessionBlockedReason, renderedThreadForActiveSession, sessionIsArchiveReadOnly } from "./workspace-selectors"
export { AnnotationComments, ArtifactDock, PreviewVariantThumbnail, artifactAuthorizationKey, capturePreviewThumbnailState } from "./artifact-dock"
export { HistoryPanel } from "./history-panel"

export type WorkspaceShellProps = {
  clientKind?: ClientKind
  rpcUrl?: string
  rpcToken?: string
  resolveRpcEndpoint?: () => Promise<{ url: string; token: string }>
  localDaemon?: LocalDaemonDescription
  windowBridge?: DesktopWindowBridge
  platform?: WorkspacePlatform
  onChangeCredential?: () => void
  // Where this client keeps each daemon's relay identity pin. Absent means no
  // pin is kept and none is reconciled; the web passes localStorage.
  relayPinStorage?: RelayPinStorage
}



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

export function restoreFocusAfterUpdate(
  target: { current: { focus(): void } | null },
  schedule: (callback: () => void) => void = (callback) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => callback())
    } else {
      queueMicrotask(callback)
    }
  },
): void {
  schedule(() => target.current?.focus())
}

export const providerSettingsNavigationLabel = "Provider settings"

export function skillInventoryRefreshKey(snapshot: WorkspaceSnapshot | null): string {
  const machine = snapshot?.machine
  return machine
    ? JSON.stringify([machine.id, machine.name, machine.platform, machine.arch, machine.version])
    : "no-machine"
}

// The daemon keys its catalog by the project path, and a branch can carry
// different project skills, so a refresh follows those facts and nothing else
// a workspace change may bring.
export function skillProjectRefreshKey(snapshot: WorkspaceSnapshot | null): string {
  const project = snapshot?.project
  return project ? JSON.stringify([project.id, project.path, project.branch]) : "no-project"
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

function WindowControls({ bridge }: { bridge: DesktopWindowBridge }) {
  if (bridge.platform === "darwin") return <div className="w-[64px]" aria-hidden="true" />

  return (
    <div className="electron-no-drag flex h-full items-stretch">
      <Button variant="ghost" size="icon" aria-label="Minimize" onClick={bridge.minimize}>
        <MinusIcon />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Maximize" onClick={bridge.maximize}>
        <SquareIcon />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Close" onClick={bridge.close}>
        <XIcon />
      </Button>
    </div>
  )
}

export function AppBar({
  snapshot,
  connected,
  emergencyStopPending,
  emergencyStopOutcome,
  emergencyStopError,
  bridge,
  windowDecoration = "domovoi",
  onOpenProject,
  onPauseAll,
  onEmergencyStop,
  onOpenCommands,
  commandShortcut,
  sessionsDrawer,
}: {
  snapshot: WorkspaceSnapshot | null
  connected: boolean
  emergencyStopPending: boolean
  emergencyStopOutcome: SystemEmergencyStopResult | null
  emergencyStopError: string | null
  bridge?: DesktopWindowBridge | undefined
  windowDecoration?: WorkspaceWindowDecoration | undefined
  onOpenProject: () => void
  // Two controls, kept apart: pausing stops at the next turn boundary, the
  // emergency stop kills processes now.
  onPauseAll: () => void
  onEmergencyStop: () => void
  onOpenCommands?: (() => void) | undefined
  commandShortcut?: string | undefined
  sessionsDrawer?: ReactNode | undefined
}) {
  const ownsDecoration = Boolean(bridge) && windowDecoration === "domovoi"
  const emergencyStopMessage = emergencyStopError
    ? `Emergency stop failed: ${emergencyStopError}`
    : emergencyStopOutcome
      ? emergencyStopAnnouncement(emergencyStopOutcome)
      : null
  return (
    <header className="electron-drag flex h-[var(--shell-titlebar)] shrink-0 items-center border-b bg-sidebar px-3">
      {ownsDecoration && bridge?.platform === "darwin" ? <div className="w-[64px]" aria-hidden="true" /> : null}
      <div className="electron-no-drag flex min-w-0 flex-1 items-center gap-2">
        <DomovoiMark reduced className="size-5 text-primary" />
        <span className="text-sm font-semibold tracking-[-0.025em]">Domovoi</span>
        <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
        {sessionsDrawer}
        <Button variant="ghost" size="sm" className="hidden sm:flex" disabled={!snapshot} onClick={onOpenProject}>
          {snapshot?.project?.name ?? "Open project"}
          {snapshot?.project ? (
            <span className="font-machine text-[10px] text-faint">{snapshot.project.branch}</span>
          ) : null}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
        <Badge variant="machine">
          <StatusDot
            meaning={connected ? "online" : "offline"}
            label={`${connected ? "Connected to" : "Disconnected from"} ${snapshot?.machine.name ?? "daemon"}.`}
            size="inline"
            labelHidden
          />
          <span className="hidden sm:inline">{snapshot?.machine.name ?? "daemon"}</span>
        </Badge>
      </div>
      <div className="electron-no-drag flex items-center gap-2">
        {onOpenCommands ? (
          <Button variant="ghost" size="sm" aria-label="Open command palette" onClick={onOpenCommands}>
            <SearchIcon data-icon="inline-start" />
            <span className="hidden md:inline">Commands</span>
            {commandShortcut ? <kbd className="hidden font-machine text-mono-xs text-muted-foreground lg:inline">{commandShortcut}</kbd> : null}
          </Button>
        ) : null}
        <StopMenu connected={connected} pending={emergencyStopPending} onPauseAll={onPauseAll} onEmergencyStop={onEmergencyStop} />
        {snapshot?.approvals.length ? (
          <Badge variant="warning">{snapshot.approvals.length} approval</Badge>
        ) : null}
        {emergencyStopMessage ? (
          <span
            role={emergencyStopError ? "alert" : "status"}
            aria-live={emergencyStopError ? "assertive" : "polite"}
            className="sr-only"
          >
            {emergencyStopMessage}
          </span>
        ) : null}
      </div>
      {ownsDecoration && bridge ? <WindowControls bridge={bridge} /> : null}
    </header>
  )
}


export function useUsageToday(
  connected: boolean,
  key: string | null,
  fetch: (window: UsageWindowParams) => Promise<UsageWindow>,
): UsageWindow | null {
  const [usage, setUsage] = useState<UsageWindow | null>(null)
  useEffect(() => {
    if (!connected || !key) {
      setUsage(null)
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      const now = new Date()
      void fetch(usageTodayWindow(now)).then((next) => {
        if (active) setUsage(next)
      }, () => {
        if (active) setUsage(null)
      })
      timer = setTimeout(refresh, usageTodayRefreshDelayMs(now))
    }
    refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [connected, fetch, key])
  return usage
}



function outcomeCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function emergencyStopAnnouncement(result: SystemEmergencyStopResult): string {
  const { outcomes } = result
  const summary = [
    outcomeCount(outcomes.turnsStopped, "turn stopped", "turns stopped"),
    outcomeCount(outcomes.terminalsClosed, "terminal closed", "terminals closed"),
    outcomeCount(outcomes.approvalsDenied, "approval denied", "approvals denied"),
    outcomeCount(
      outcomes.mutationsCancelled,
      "mutation cancelled",
      "mutations cancelled",
    ),
    outcomeCount(outcomes.providersReset, "provider reset", "providers reset"),
  ]
  if (result.failures.length > 0) {
    summary.push(outcomeCount(result.failures.length, "failure", "failures"))
  }
  return `Emergency stop complete: ${summary.join(", ")}.`
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


export { providerHandoffChoices, openProviderChoice, forkProviderChoice, type ProviderChoice } from "./provider-choice-dialog.js"

export function normalizePermissionMode(runtime: Runtime, permissionMode: PermissionMode): Runtime {
  return withPermissionMode(runtime, permissionMode)
}

export { CheckpointFork, CheckpointRestore, CheckpointRestoreAction, checkpointBlockedReason, checkpointRestoreBlocked }


export function WorkspaceShell({ clientKind = "web", rpcUrl = "ws://127.0.0.1:47831/rpc", rpcToken, resolveRpcEndpoint, localDaemon, windowBridge, platform, onChangeCredential, relayPinStorage }: WorkspaceShellProps) {
  const [attached, setAttached] = useState<{ machineId: string } | null>(null)
  // The queue outlives the thread view and is not limited to the session on
  // screen. Thread is keyed by session, so a switch unmounts it; and a message
  // queued in A must leave at A's next turn boundary whether or not anyone is
  // looking at A.
  const [queues, setQueues] = useState<SessionQueues>({})
  // Every send that did not come back, kept by identity. One slot per session
  // was still one slot: a second refusal would erase the first receipt and the
  // reason with it.
  const [failures, setFailures] = useState<readonly FailedAttempt[]>([])
  const nextAttemptId = useRef(0)
  const releasing = useRef<Set<string>>(new Set())
  // Bumped when a dispatch settles. A settlement that changed nothing else
  // would otherwise leave a session that became eligible mid-flight waiting
  // for some unrelated render to wake it.
  const [settled, setSettled] = useState(0)
  const [seenStop, setSeenStop] = useState<SystemEmergencyStopResult | null>(null)
  const home = useWorkspace(rpcUrl, clientKind, rpcToken, resolveRpcEndpoint, undefined, relayPinStorage)
  const homeMachineId = home.snapshot?.machine.id ?? null
  const accessScope = JSON.stringify([homeMachineId, clientKind, rpcUrl, rpcToken])
  const accessInputs = useRef({ scope: accessScope, homeUrl: home.endpointUrl, kind: clientKind, route: home.fleetClientRoute,
    ...(windowBridge ? { bridge: windowBridge } : {}) })
  accessInputs.current = { scope: accessScope, homeUrl: home.endpointUrl, kind: clientKind, route: home.fleetClientRoute,
    ...(windowBridge ? { bridge: windowBridge } : {}) }
  const accessSession = useMemo(() => new FleetAccessSession(() => {
    const { scope, ...inputs } = accessInputs.current
    if (scope !== accessScope) throw new ClientAdmissionError("not-enrolled")
    return inputs
  }), [accessScope])
  const clientAccess = useSyncExternalStore(accessSession.subscribe, accessSession.snapshot, accessSession.snapshot)
  const admittedMachines = useMemo(() => new Set(Object.entries(clientAccess).filter(([, access]) => access.state === "admitted").map(([id]) => id)), [clientAccess])
  useEffect(() => () => accessSession.clear(), [accessSession])
  useEffect(() => {
    if (home.fleet) accessSession.retain(fleetMachines(home.fleet.entries))
  }, [home.fleet, accessSession])
  const access = attached ? accessSession.access(attached.machineId) : undefined
  const remote = useWorkspace(rpcUrl, clientKind, undefined, undefined,
    access ? { state: "client", admission: access,
      resolveEndpoint: (deadline) => prepareFleetEndpoint({ ...accessInputs.current, ...access, deadline }),
    } : { state: "disabled" }, relayPinStorage)
  const { fleet, fleetOverflow, forgetMachine, pairMachine, listDevices, revokeDevice, rotateDevice, renameDevice } = home
  const homeSkillInventory = home.getSkillInventory
  const {
    activateSession,
    archiveSession,
    authorizeArtifact,
    claimTerminal,
    closeTerminal,
    connected,
    createCheckpoint,
    createAnnotation,
    createSession,
    emergencyStop,
    emergencyStopError,
    emergencyStopOutcome,
    emergencyStopPending,
    pauseAll,
    endpointUrl,
    forkSession,
    getSkillInventory,
    createTerminal,
    listModels,
    revokeApprovalRule,
    listHardGates,
    discoverRuntime,
    listProviderSecrets,
    listSkills,
    exportAudit,
    loadSessionHistory,
    loadSessionEvidence,
    openProject,
    pauseSession,
    queryAudit,
    readSkill,
    refreshProviders,
    reconnect,
    restoreCheckpoint,
    revertSessionFile,
    editPlan,
    discardPlanEdit,
    restartProviderThread,
    resizeTerminal,
    resolveApproval,
    replyToAnnotation,
    reviewSkill,
    previewSkillInstall,
    installSkill,
    sendMessage,
    sessionUsage,
    usageWindow,
    setSkillEnabled,
    setRuntime,
    setAnnotationStatus,
    snapshot,
    subscribeTerminal,
    terminalClientId,
    transferSession,
    previewTransfer,
    releaseSession,
    writeTerminal,
    authenticationRequired,
    protocolError,
    reconnecting,
  } = attached ? remote : home
  const terminalControls = useMemo<TerminalControls>(() => ({
    clientId: terminalClientId,
    create: createTerminal,
    claim: claimTerminal,
    write: writeTerminal,
    resize: resizeTerminal,
    close: closeTerminal,
    subscribe: subscribeTerminal,
  }), [claimTerminal, closeTerminal, createTerminal, resizeTerminal, subscribeTerminal, terminalClientId, writeTerminal])
  // Home remains connected while a remote workspace is in use. Its registry,
  // enrollment and client-route verifier never come from the selected target.
  useEffect(() => {
    if (attached && remote.authenticationRequired) accessSession.refuse(attached.machineId, remote.authenticationRequired)
  }, [attached, remote.authenticationRequired, accessSession])

  const switchMachine = useCallback((machineId: string): boolean => {
    if (machineId === homeMachineId) {
      setAttached(null)
      return true
    }
    const machine = fleetMachines(fleet?.entries ?? []).find((candidate) => candidate.id === machineId)
    if (!machine) return false
    const selected = accessSession.access(machineId)
    if (!home.connected || !selected || !machineAttachment(machine, true).selectable) return false
    setAttached({ machineId })
    return true
  }, [fleet, homeMachineId, accessSession, home.connected])
  const removeClientAccess = (machineId: string) => {
    accessSession.remove(machineId)
    if (attached?.machineId === machineId) setAttached(null)
    const forgetRoute = windowBridge?.forgetFleetRoute
    if (forgetRoute) {
      const deadline = Deadline.start(5_000)
      void withinFleetDeadline(deadline, () => forgetRoute(machineId)).catch(() => {}).finally(() => deadline.clear())
    }
  }

  const shellRef = useRef<HTMLDivElement>(null)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const dockCollapseButtonRef = useRef<HTMLButtonElement>(null)
  const dockExpandButtonRef = useRef<HTMLButtonElement>(null)
  const dockUnpinButtonRef = useRef<HTMLButtonElement>(null)
  const sheetPinButtonRef = useRef<HTMLButtonElement>(null)
  const notificationTrackerRef = useRef(new WorkspaceNotificationTracker())
  const commandPaletteFocusRef = useRef<HTMLElement | null>(null)
  const deepLinkRoutingRef = useRef(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [requestedSkillId, setRequestedSkillId] = useState<string>()
  const [pendingDeepLinks, setPendingDeepLinks] = useState<string[]>([])
  const [launcherMode, setLauncherMode] = useState<LauncherMode>(null)
  // A launch the palette asked for on a named machine. It becomes a launcher
  // only when that machine is the one attached and its snapshot has a project.
  const [launchIntent, setLaunchIntent] = useState<{ machineId: string } | null>(null)
  const [launcherProjectNote, setLauncherProjectNote] = useState("")
  const [notificationDelivery, setNotificationDelivery] = useState<WorkspaceNotificationDelivery | undefined>(
    () => platform?.notifications.delivery(),
  )
  const [installState, setInstallState] = useState<WorkspaceInstallState | undefined>(
    () => platform?.install.state(),
  )
  const [workspaceUi, setWorkspaceUi] = useState(() =>
    loadWorkspaceUiState(browserWorkspaceUiStorage()),
  )
  const firstRunEnabled = desktopFirstRunAvailable(clientKind, windowBridge)
  const [desktopFirstRun, setDesktopFirstRun] = useState<{
    persisted: DesktopFirstRunState
    open: boolean
    selectedProviderId: string
    permissionMode: PermissionMode
    refreshing: boolean
    error: string
  }>(() => {
    const persisted = firstRunEnabled
      ? loadDesktopFirstRunState(browserDesktopFirstRunStorage())
      : defaultDesktopFirstRunState()
    return {
      persisted,
      open: firstRunEnabled && persisted.status === "pending",
      selectedProviderId: persisted.status === "complete" ? persisted.providerId : "",
      permissionMode: persisted.status === "complete" ? persisted.permissionMode : "build",
      refreshing: false,
      error: "",
    }
  })
  const {
    dockCollapsed,
    dockPinned,
    externalEditor,
    layouts,
    notifications: notificationPreferences,
    surface,
    theme,
    windowDecoration,
  } = workspaceUi
  const [activeWindowDecoration, setActiveWindowDecoration] = useState<WorkspaceWindowDecoration>("domovoi")
  useAppearanceTheme(theme)
  const commandPlatform: CommandPalettePlatform = windowBridge?.platform
    ?? (typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "darwin" : "linux")
  const setDockCollapsed = (collapsed: boolean) => {
    const activePanel = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement.closest("[data-workspace-panel]")?.getAttribute("data-workspace-panel")
      : null
    setWorkspaceUi((current) => ({ ...current, dockCollapsed: collapsed }))
    if ((collapsed && activePanel === "dock") || (!collapsed && activePanel === "dock-rail")) {
      restoreFocusAfterUpdate(collapsed ? dockExpandButtonRef : dockCollapseButtonRef)
    }
  }
  const setDockPinned = (pinned: boolean) => {
    setWorkspaceUi((current) => ({ ...current, dockPinned: pinned }))
    // Pinning unmounts the floating sheet rather than updating it, and that
    // unmount returns focus to whatever opened the sheet. Put focus on the
    // control that now owns the state instead.
    restoreFocusAfterUpdate(pinned ? dockUnpinButtonRef : sheetPinButtonRef)
  }

  const changeWindowDecoration = (decoration: WorkspaceWindowDecoration) => {
    setWorkspaceUi((current) => ({ ...current, windowDecoration: decoration }))
    if (!windowBridge) return
    setWorkspaceError("")
    void windowBridge.setWindowDecoration(decoration).then((saved) => {
      if (!saved) setWorkspaceError("The window decoration preference could not be saved")
    }, (cause: unknown) => {
      setWorkspaceError(
        cause instanceof Error ? cause.message : "The window decoration preference could not be saved",
      )
    })
  }
  const setSurface = (nextSurface: WorkspaceSurface) => {
    setWorkspaceUi((current) => ({ ...current, surface: nextSurface }))
  }
  const [workspaceError, setWorkspaceError] = useState("")
  const [projectSwitchConfirmation, setProjectSwitchConfirmation] = useState<ProjectSwitchConfirmation | null>(null)
  const [projectSwitchPending, setProjectSwitchPending] = useState(false)
  const [projectSwitchError, setProjectSwitchError] = useState("")
  const [connectionError, setConnectionError] = useState("")
  const [providerSecrets, setProviderSecrets] = useState<ProviderSecretStatus[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillInventories, setSkillInventories] = useState<SkillInventorySource[]>([])
  const [localSkillInventory, setLocalSkillInventory] = useState<SkillInventorySource | null>(null)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState("")
  const [skillsRefresh, setSkillsRefresh] = useState(0)
  const [activeSessionUsage, setActiveSessionUsage] = useState<SessionUsage | null>(null)
  const [dockTab, setDockTab] = useState<string>(clientKind === "desktop" ? "changes" : "preview")
  // Held above the pin and unpin swaps, each of which removes the control that
  // was focused. The sheet cannot capture this for itself.
  const dockOpenerRef = useRef<Element | null>(null)
  const openDockTab = (next: string) => {
    dockOpenerRef.current = document.activeElement
    setDockTab(next)
    setDockCollapsed(false)
  }
  // Checkpoints is a view of History rather than a pane beside it. The request
  // id rises on every call because a second press carries the same category as
  // the first, and the pane has no other way to tell them apart.
  // The history row forks at the session's current runtime. Choosing a
  // different provider or model is the thread dialog's job, not a row's.
  const forkFromCheckpoint = (checkpointId: string) => {
    const active = snapshot ? activeSession(snapshot) : undefined
    if (!active) return
    void forkSession({
      sessionId: active.id,
      checkpointId,
      runtime: active.runtime,
      requestId: `fork-${globalThis.crypto.randomUUID()}`,
    })
  }
  // The v2 sheet gives checkpoints a tab of their own, so the affordances that
  // name Checkpoints open that tab. History keeps its category focus for the
  // filters it still narrows by.
  const openCheckpoints = () => {
    setSurface("workspace")
    openDockTab("checkpoints")
  }
  const activeWorkspacePath = snapshot?.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  )?.workspacePath
  const skillMachineKey = skillInventoryRefreshKey(snapshot)
  const skillProjectKey = skillProjectRefreshKey(snapshot)
  // The composer names the skills a turn carries, so the catalog cannot wait
  // for someone to open the Skills surface first.
  const skillsWanted = surface === "skills" || skillProjectKey !== "no-project"
  const skillMachine = useMemo(() => {
    if (skillMachineKey === "no-machine") return null
    const [id, name, platform, arch, version] = JSON.parse(skillMachineKey) as [
      string,
      string,
      WorkspaceSnapshot["machine"]["platform"],
      string,
      string,
    ]
    return { id, name, platform, arch, version }
  }, [skillMachineKey])
  const activateVisibleSession = (sessionId: string) => {
    setWorkspaceError("")
    void activateSession(sessionId).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "The session could not be opened")
    })
  }
  // Opening a session means showing its thread. Activation alone leaves whatever
  // surface is open in place, so a pick from Settings would have no composer.
  const openSessionInWorkspace = (sessionId: string) => {
    setSurface("workspace")
    activateVisibleSession(sessionId)
  }
  const [machineMenuRequest, setMachineMenuRequest] = useState(0)
  // Fork and Move need the person to choose a checkpoint or a machine on the
  // session the row names. Activation is a round trip and the thread remounts
  // on it, so the destination is held as an intent scoped to that session and
  // opened only once the snapshot says that session is active; a refusal or a
  // machine change drops it rather than opening controls on the wrong thread.
  const [rowIntent, setRowIntent] = useState<{ action: "fork" | "move", sessionId: string } | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null)
  const sessionRowAction = (action: SessionRowAction, sessionId: string) => {
    if (action === "stop") {
      // Stop holds that session's queued message the way the composer's Stop
      // does, so the queue does not leave at the boundary the stop created.
      setQueues((current) => {
        const queued = current[sessionId]
        return queued ? setQueue(current, sessionId, heldAfter(queued, "Held because this session was stopped. Send it when you want it to run.")) : current
      })
      void pauseSession(sessionId).catch((cause: unknown) => setConnectionError(cause instanceof Error ? cause.message : "The session could not be stopped"))
      return
    }
    if (action === "archive") {
      // Archiving stops the session's resources and removes its worktree; the
      // row asks first, with the same words the composer's Archive uses.
      setArchiveTarget(sessionId)
      return
    }
    setRowIntent({ action, sessionId })
    setSurface("workspace")
    if (snapshot?.activeSessionId !== sessionId) activateVisibleSession(sessionId)
  }
  useEffect(() => {
    if (!rowIntent || snapshot?.activeSessionId !== rowIntent.sessionId) return
    if (rowIntent.action === "fork") openDockTab("checkpoints")
    else setMachineMenuRequest((current) => current + 1)
    setRowIntent(null)
    // openDockTab is a plain function on the shell; the intent and the active
    // session are what decide whether this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIntent, snapshot?.activeSessionId])
  useEffect(() => {
    if (workspaceError || attached !== null) setRowIntent(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceError, attached?.machineId])
  const reconnectDaemon = () => {
    setConnectionError("")
    void reconnect().catch((cause: unknown) => {
      setConnectionError(cause instanceof Error ? cause.message : "The daemon could not be reached")
    })
  }
  const retryDesktopFirstRun = () => {
    if (!firstRunEnabled || desktopFirstRun.refreshing) return
    setDesktopFirstRun((current) => ({ ...current, refreshing: true, error: "" }))
    const refresh = async () => {
      if (!connected) await reconnect()
      await refreshProviders()
    }
    void refresh().catch((cause: unknown) => {
      setDesktopFirstRun((current) => ({
        ...current,
        error: cause instanceof Error ? cause.message : "Provider diagnostics could not be refreshed",
      }))
    }).finally(() => {
      setDesktopFirstRun((current) => ({ ...current, refreshing: false }))
    })
  }
  const copyFirstRunGuidance = (value: string) => {
    if (!windowBridge) return
    setDesktopFirstRun((current) => ({ ...current, error: "" }))
    void copyDesktopText(windowBridge, value).catch((cause: unknown) => {
      setDesktopFirstRun((current) => ({
        ...current,
        error: cause instanceof Error ? cause.message : "Guidance could not be copied",
      }))
    })
  }
  const completeFirstRun = () => {
    if (!firstRunEnabled || !connected || !snapshot) return
    const provider = snapshot.machine.providers.find(
      (candidate) => candidate.id === desktopFirstRun.selectedProviderId,
    )
    if (!provider || !providerFirstRunRecovery(
      provider,
      firstRunFailureForProvider(provider.id, snapshot.sessions),
    ).canComplete) {
      setDesktopFirstRun((current) => ({
        ...current,
        error: "Choose a provider whose diagnostics are ready before finishing setup.",
      }))
      return
    }
    const completed = completeDesktopFirstRun({
      providerId: provider.id,
      permissionMode: desktopFirstRun.permissionMode,
    })
    saveDesktopFirstRunState(browserDesktopFirstRunStorage(), completed)
    setDesktopFirstRun((current) => ({
      ...current,
      persisted: completed,
      open: false,
      error: "",
    }))
  }
  const resetFirstRun = () => {
    if (!firstRunEnabled) return
    resetDesktopFirstRunState(browserDesktopFirstRunStorage())
    const providers = snapshot?.machine.providers ?? []
    const provider = preferredSessionProvider(providers) ?? providers[0]
    setDesktopFirstRun({
      persisted: defaultDesktopFirstRunState(),
      open: true,
      selectedProviderId: provider?.id ?? "",
      permissionMode: "build",
      refreshing: false,
      error: "",
    })
  }
  // Pause everything stops at the next turn boundary through system.pauseAll;
  // the emergency stop is the other thing and has its own control.
  // Hold first: the pause's snapshot leaves every session idle, and an idle
  // session with a waiting queue would be resumed by the release effect.
  const pauseActiveTurns = () => {
    setQueues(holdAllAfterStop)
    void pauseAll().catch(() => undefined)
  }
  const stopEverything = () => {
    void emergencyStop()
  }

  // Any client's stop, not just this one's. The daemon broadcasts
  // system.emergencyStopped and use-workspace surfaces it here, so a stop
  // pressed on a phone holds the queue on the desktop too.
  //
  // Adjusted during render rather than in an effect on purpose. A stop arrives
  // with the idle snapshot in the same render, and two effects on one commit
  // race: the release effect would read the queues of that render, still
  // waiting, and send the work the stop just ended. Setting state during
  // render makes React re-run this component before any effect fires.
  if (emergencyStopOutcome && emergencyStopOutcome !== seenStop) {
    setSeenStop(emergencyStopOutcome)
    setQueues(holdAllAfterStop)
  }
  useEffect(() => {
    if (!emergencyStopPending) return
    setQueues(holdAllAfterStop)
  }, [emergencyStopPending])

  // The release lives here rather than in Thread because a turn ending in A is
  // A's business whether or not A is the session on screen.
  useEffect(() => {
    for (const message of releasableQueues(snapshot?.sessions ?? [], queues, { busy: emergencyStopPending })) {
      const session = { id: message.sessionId }
      if (releasing.current.has(session.id)) continue
      const chosen = message.skillIds
      // Waiting, not held: an unloaded catalog says nothing about whether the
      // chosen skill still exists, and "your skill is gone" is a lie until it
      // has answered.
      if (chosen && chosen.length > 0 && localSkillInventory?.state !== "available") continue
      const { selection, missing } = turnSkillSelectionFor(
        chosen ? new Set(chosen) : undefined,
        selectableTurnSkills(skills, snapshot?.skillEnablements ?? [], snapshot?.project?.id),
      )
      // Sending without them would quietly become a smaller selection, or an
      // explicit "no skills" if every chosen skill has gone.
      if (missing.length > 0) {
        setQueues((current) => setQueue(current, session.id, heldAfter(
          message,
          `Held because ${missing.length === 1 ? "a skill" : `${missing.length} skills`} you chose is no longer in this project's catalog.`,
        )))
        continue
      }
      releasing.current.add(session.id)
      setQueues((current) => setQueue(current, session.id, undefined))
      void sendMessage(session.id, message.text, selection)
        .catch((cause: unknown) => {
          // Recorded, never re-queued: a refused message put back as waiting
          // would be retried by this effect on the very next render, forever.
          // A daemon error means nothing ran. Anything else means the answer
          // was lost, and Domovoi cannot say whether the turn started.
          // Built before the updater runs. Reading the counter inside it gives
          // batched refusals the same id, and then dismissing one deletes another.
          nextAttemptId.current += 1
          const attempt = failedAttempt(
            `attempt-${nextAttemptId.current}`,
            message,
            {
              refused: cause instanceof DaemonRpcError && provesNothingRan(cause.code),
              answered: cause instanceof DaemonRpcError,
              reason: cause instanceof Error ? cause.message : "The message could not be sent",
            },
          )
          setFailures((current) => [...current, attempt])
        })
        .finally(() => {
          releasing.current.delete(session.id)
          setSettled((count) => count + 1)
        })
    }
  }, [snapshot, queues, emergencyStopPending, skills, sendMessage, localSkillInventory, settled])
  const openProjectSafely = async (path: string) => {
    try {
      await openProject(path)
    } catch (cause) {
      if (cause instanceof ProjectSwitchConfirmationError) {
        setProjectSwitchError("")
        setProjectSwitchConfirmation(cause.confirmation)
        return
      }
      throw cause
    }
  }
  const confirmProjectSwitch = async (path: string) => {
    if (projectSwitchPending || projectSwitchConfirmation?.requestedPath !== path) return
    setProjectSwitchPending(true)
    setProjectSwitchError("")
    try {
      await openProject(path, projectSwitchConfirmation)
      setProjectSwitchConfirmation(null)
    } catch (cause) {
      if (cause instanceof ProjectSwitchConfirmationError) {
        setProjectSwitchConfirmation(cause.confirmation)
        setProjectSwitchError("Sessions changed while confirmation was open. Review the updated impact.")
      } else {
        setProjectSwitchError(cause instanceof Error ? cause.message : "Domovoi could not switch projects")
      }
    } finally {
      setProjectSwitchPending(false)
    }
  }
  const requestOpenProject = () => {
    setWorkspaceError("")
    if (windowBridge && !attached) {
      void openProjectFromDesktop(windowBridge, openProjectSafely).catch((cause: unknown) => {
        setWorkspaceError(cause instanceof Error ? cause.message : "Domovoi could not open the selected project")
      })
      return
    }
    if (!platform || attached) {
      setLauncherMode("project")
      return
    }
    void platform.dialogs.pickProjectDirectory().then(async (choice) => {
      if (choice.status === "selected") {
        await openProjectSafely(choice.path)
        return
      }
      setLauncherProjectNote(choice.message)
      setLauncherMode("project")
    }).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "Domovoi could not open the selected project")
    })
  }
  const openActiveWorkspaceInEditor = () => {
    if (!windowBridge || !activeWorkspacePath || attached) return
    setWorkspaceError("")
    void openDesktopPath(windowBridge, activeWorkspacePath, externalEditor).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "External editor could not open the worktree")
    })
  }
  const copyActiveWorkspacePath = () => {
    if (!activeWorkspacePath) return
    const copied = windowBridge
      ? copyDesktopText(windowBridge, activeWorkspacePath)
      : platform?.clipboard.writeText(activeWorkspacePath)
    if (!copied) return
    setWorkspaceError("")
    void copied.catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "Clipboard text could not be copied")
    })
  }
  const requestNotificationDelivery = () => {
    if (!platform) return
    void platform.notifications.request().then(setNotificationDelivery)
  }
  const requestInstall = () => {
    if (!platform) return
    void platform.install.prompt().then(setInstallState)
  }
  const openCommandPalette = () => {
    commandPaletteFocusRef.current = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setCommandPaletteOpen(true)
  }
  const workspaceCommands = buildWorkspaceCommands({
    ...((windowBridge || platform) && activeWorkspacePath && !attached ? {
      activeWorkspacePath,
      copyWorktreePath: copyActiveWorkspacePath,
    } : {}),
    ...(windowBridge && activeWorkspacePath ? {
      openInEditor: openActiveWorkspaceInEditor,
      externalEditor,
    } : {}),
    connected,
    emergencyStopPending,
    hasProject: Boolean(snapshot?.project),
    openProject: requestOpenProject,
    newSession: () => setLauncherMode(snapshot?.project ? "session" : "project"),
    pauseAll: pauseActiveTurns,
    emergencyStop: stopEverything,
    reconnect: reconnectDaemon,
    setSurface,
    sessions: snapshot?.sessions ?? [],
    entries: fleet?.entries,
    admittedMachines,
    skills,
    activateSession: openSessionInWorkspace,
    selectMachine: switchMachine,
    openCheckpoints,
    // Cmd+Enter on a machine starts a session there: attach to that daemon,
    // then open the launcher on it. The intent names the machine, and the
    // launcher opens only once that machine's snapshot is the one on screen;
    // a refused or abandoned attachment drops it rather than opening the form
    // on whichever daemon is left.
    startSessionOn: (machineId: string) => {
      if (!switchMachine(machineId)) return
      setLaunchIntent({ machineId })
    },
    // The launcher names the target. The preflight takes the decision, so this
    // opens the transfer dialog and never moves anything itself. The intent is
    // bound to the session and the machine it was made on: the dialog opens
    // only once that session is the active one, and a refused activation or a
    // switch of daemon drops the intent rather than handing it to whichever
    // session is on screen.
    previewTransferTo: (sessionId: string, machineId: string) => {
      setSurface("workspace")
      setWorkspaceError("")
      const sourceMachineId = attached?.machineId ?? snapshot?.machine.id ?? null
      setLauncherTransfer({ sessionId, machineId, sourceMachineId, opened: false })
      void activateSession(sessionId).catch((cause: unknown) => {
        setLauncherTransfer((current) => current?.sessionId === sessionId ? null : current)
        setWorkspaceError(cause instanceof Error ? cause.message : "The session could not be opened")
      })
    },
    currentMachineId: attached?.machineId ?? snapshot?.machine.id,
    transferEntries: attached ? remote.fleet?.entries ?? [] : fleet?.entries,
    openSkill: (skillId) => {
      setRequestedSkillId(skillId)
      setSurface("skills")
    },
  })
  const usageSessionId = snapshot?.activeSessionId ?? null
  const usageFetchKey = sessionUsageFetchKey(snapshot)
  const usageToday = useUsageToday(connected, usageWindowFetchKey(snapshot), usageWindow)
  const loadLatestTurn = useCallback(async (signal: AbortSignal): Promise<SessionTurn | undefined> => {
    const sessionId = snapshot?.activeSessionId
    return sessionId ? latestTurnFromHistory(loadSessionHistory, sessionId, signal) : undefined
  }, [loadSessionHistory, snapshot?.activeSessionId])
  // Restore ownership sits here, above both surfaces. The thread guards its own
  // pending operations and the dock cannot see that state, so a restore started
  // from either one has to hold the other shut until it answers.
  const [checkpointRestorePending, setCheckpointRestorePending] = useState(false)
  // Named by the launcher, consumed by the thread's transfer dialog once the
  // named session is the active one on the daemon it was named on.
  // `opened` separates an intent still waiting for its session to activate
  // from one whose dialog has been shown: leaving the session after that is
  // leaving the dialog, so the intent goes with it rather than waiting to
  // reappear when the session is next active.
  const [launcherTransfer, setLauncherTransfer] = useState<{ sessionId: string; machineId: string; sourceMachineId: string | null; opened: boolean } | null>(null)
  const launcherTransferMachineId = attached?.machineId ?? snapshot?.machine.id ?? null
  const launcherTransferTargetId = launcherTransfer
    && launcherTransfer.sessionId === snapshot?.activeSessionId
    && launcherTransfer.sourceMachineId === launcherTransferMachineId
    ? launcherTransfer.machineId
    : null
  const activeSessionId = snapshot?.activeSessionId ?? null
  useEffect(() => {
    if (!launcherTransfer) return
    if (launcherTransfer.sourceMachineId !== launcherTransferMachineId) { setLauncherTransfer(null); return }
    if (launcherTransfer.sessionId === activeSessionId) {
      if (!launcherTransfer.opened) setLauncherTransfer({ ...launcherTransfer, opened: true })
    } else if (launcherTransfer.opened) {
      setLauncherTransfer(null)
    }
  }, [launcherTransfer, launcherTransferMachineId, activeSessionId])
  useEffect(() => {
    if (!launchIntent) return
    const onMachine = (attached?.machineId ?? homeMachineId) === launchIntent.machineId
    if (!onMachine) { setLaunchIntent(null); return }
    if (!connected || !snapshot?.project) return
    setLaunchIntent(null)
    setLauncherMode("session")
  }, [launchIntent, attached, homeMachineId, connected, snapshot])
  const setLauncherTransferTargetId = (machineId: string | null) => {
    if (machineId === null) { setLauncherTransfer(null); return }
    const sessionId = snapshot?.activeSessionId
    if (sessionId) setLauncherTransfer({ sessionId, machineId, sourceMachineId: launcherTransferMachineId, opened: true })
  }
  // Both surfaces restore through this one function, so an attempt started from
  // either holds the other shut for as long as it runs.
  const restoreCheckpointGuarded = async (sessionId: string, checkpointId: string) => {
    if (checkpointRestorePending) return
    setCheckpointRestorePending(true)
    try {
      await restoreCheckpoint(sessionId, checkpointId)
    } finally {
      setCheckpointRestorePending(false)
    }
  }
  const restoreCheckpointOnce = (checkpointId: string) => {
    if (!snapshot?.activeSessionId || checkpointRestorePending) return
    setWorkspaceError("")
    void restoreCheckpointGuarded(snapshot.activeSessionId, checkpointId).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "The checkpoint could not be restored")
    })
  }
  // One dock, rendered either as the pinned panel or inside the floating sheet.
  // Named before the snapshot exists, because the snapshot is what is being
  // waited for. The endpoint is what this client actually knows it is reading.
  const readingLabel = `reading ${attached?.machineId ?? endpointUrl}`
  const machineSurfaces = snapshot ? <ArtifactDock snapshot={snapshot} onCollapse={() => setDockCollapsed(true)} collapseButtonRef={dockCollapseButtonRef} defaultTab={clientKind === "desktop" ? "changes" : "preview"} tab={dockTab} onTabChange={setDockTab} rpcUrl={endpointUrl} authorizeArtifact={authorizeArtifact} connected={connected} terminalControls={terminalControls} onCreateAnnotation={createAnnotation} onLoadSessionHistory={loadSessionHistory} onRevokeApprovalRule={revokeApprovalRule} onLoadHardGates={listHardGates} onRestoreCheckpoint={restoreCheckpointOnce} worktreeName={activeWorkspacePath?.split(/[\\/]/u).at(-1)} onForkCheckpoint={forkFromCheckpoint} restoreBusy={checkpointRestorePending} onLoadSessionEvidence={loadSessionEvidence} onRevertSessionFile={revertSessionFile} onEditPlan={(edit) => editPlan(snapshot.activeSessionId ?? "", edit)} onDiscardPlanEdit={(editId) => discardPlanEdit(snapshot.activeSessionId ?? "", editId)} onReplyToAnnotation={replyToAnnotation} onSetAnnotationStatus={setAnnotationStatus} previewRefusal={clientKind === "desktop" && attached ? "This remote connection supports RPC and Terminal. Preview frames need a separate verified path. Open the target's own app to use its previews." : undefined} {...(windowBridge ? { captureAnnotation: windowBridge.captureAnnotation } : {})} /> : null
  const layoutKey = `drawer.${dockCollapsed ? "rail" : "dock"}`
  const defaultLayout = layouts[layoutKey]

  useEffect(() => {
    notificationTrackerRef.current = new WorkspaceNotificationTracker()
  }, [clientKind, rpcUrl])

  useEffect(() => {
    if (!windowBridge) return
    let active = true
    void windowBridge.getWindowDecoration().then((decoration) => {
      if (active) setActiveWindowDecoration(decoration)
    }, () => {})
    return () => { active = false }
  }, [windowBridge])

  useEffect(() => {
    if (!connected || !usageFetchKey || !usageSessionId) {
      setActiveSessionUsage(null)
      return
    }
    let active = true
    void sessionUsage(usageSessionId).then((next) => {
      if (active) setActiveSessionUsage(next)
    }, () => {
      if (active) setActiveSessionUsage(null)
    })
    return () => { active = false }
  }, [connected, sessionUsage, usageFetchKey, usageSessionId])

  useEffect(() => {
    if (!firstRunEnabled || !snapshot) return
    const providers = snapshot.machine.providers
    setDesktopFirstRun((current) => {
      if (providers.some((provider) => provider.id === current.selectedProviderId)) return current
      const persistedProviderId = current.persisted.status === "complete"
        ? current.persisted.providerId
        : undefined
      const provider = providers.find((candidate) => candidate.id === persistedProviderId)
        ?? preferredSessionProvider(providers)
        ?? providers[0]
      const selectedProviderId = provider?.id ?? ""
      return selectedProviderId === current.selectedProviderId
        ? current
        : { ...current, selectedProviderId }
    })
  }, [firstRunEnabled, snapshot])

  useEffect(() => {
    if (!windowBridge) return
    return windowBridge.onNotificationActivate((sessionId) => {
      setWorkspaceError("")
      void activateSession(sessionId).catch((cause: unknown) => {
        setWorkspaceError(cause instanceof Error ? cause.message : "The session could not be opened")
      })
    })
  }, [activateSession, windowBridge])

  useEffect(() => {
    if (!windowBridge) return
    return windowBridge.onDeepLink((sessionId) => {
      setPendingDeepLinks((current) => enqueueDesktopDeepLink(current, sessionId))
    })
  }, [windowBridge])

  useEffect(() => {
    const sessionId = pendingDeepLinks[0]
    if (!sessionId || !connected || !snapshot || deepLinkRoutingRef.current) return
    const removeLink = () => setPendingDeepLinks((current) =>
      current[0] === sessionId ? current.slice(1) : current.filter((candidate) => candidate !== sessionId)
    )
    if (!snapshot.sessions.some((session) => session.id === sessionId)) {
      setWorkspaceError("The linked session is not available on this machine")
      removeLink()
      return
    }
    deepLinkRoutingRef.current = true
    setWorkspaceError("")
    void activateSession(sessionId).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "The linked session could not be opened")
    }).finally(() => {
      deepLinkRoutingRef.current = false
      removeLink()
    })
  }, [activateSession, connected, pendingDeepLinks, snapshot])

  useEffect(() => {
    if (!snapshot) return
    const notifications = notificationTrackerRef.current.observe(snapshot)
    const raise = windowBridge
      ? (request: DesktopNotificationRequest) => windowBridge.notify(request)
      : platform
        ? (request: DesktopNotificationRequest) => platform.notifications.notify(request)
        : undefined
    if (!raise) return
    for (const notification of notifications) {
      if (!notificationPreferenceFor(notificationPreferences, notification.kind)) continue
      void raise(notification).catch(() => {})
    }
  }, [notificationPreferences, platform, snapshot, windowBridge])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!commandPaletteShortcut(event, commandPlatform)) return
      event.preventDefault()
      if (commandPaletteOpen) {
        setCommandPaletteOpen(false)
      } else {
        openCommandPalette()
      }
    }
    globalThis.addEventListener("keydown", onKeyDown)
    return () => globalThis.removeEventListener("keydown", onKeyDown)
  }, [commandPaletteOpen, commandPlatform])

  useEffect(() => {
    if (!snapshot) return
    setWorkspaceUi((current) => reconcileWorkspaceUiState(current, {
      projectId: snapshot.project?.id ?? null,
      activeSessionId: snapshot.activeSessionId,
      sessionIds: snapshot.sessions.map(({ id }) => id),
    }))
  }, [snapshot])

  useEffect(() => {
    saveWorkspaceUiState(browserWorkspaceUiStorage(), workspaceUi)
  }, [workspaceUi])

  useEffect(() => {
    if (connected) setConnectionError("")
  }, [connected])

  useEffect(() => {
    if (surface !== "providers") return
    if (!connected) {
      setProviderSecrets([
        { provider: "anthropic", state: "unavailable", source: "keychain" },
        { provider: "openai", state: "unavailable", source: "keychain" },
        { provider: "openrouter", state: "unavailable", source: "keychain" },
      ])
      return
    }
    let active = true
    void listProviderSecrets().then(
      (statuses) => { if (active) setProviderSecrets(statuses) },
      () => {
        if (active) setProviderSecrets([
          { provider: "anthropic", state: "unavailable", source: "keychain" },
          { provider: "openai", state: "unavailable", source: "keychain" },
          { provider: "openrouter", state: "unavailable", source: "keychain" },
        ])
      },
    )
    return () => { active = false }
  }, [connected, listProviderSecrets, surface])

  // A refresh follows the machine and project keys, a reconnect, and an
  // explicit retry. Other workspace changes and surface moves leave the catalog
  // alone, and a refresh they would have made obsolete is cancelled rather than
  // left to finish for nothing.
  useEffect(() => {
    if (!skillsWanted) return
    if (!connected) {
      setLocalSkillInventory(null)
      setSkillsLoading(false)
      setSkillInventories(skillMachine ? [{
        state: "unreachable",
        machine: skillMachine,
      }] : [])
      setSkillsError("Reconnect to the execution machine to refresh its skill directories.")
      return
    }
    let active = true
    const refresh = new AbortController()
    const options = { signal: refresh.signal }
    setSkillsLoading(true)
    setSkillsError("")
    void Promise.all([listSkills(options), getSkillInventory(options)]).then(
      ([discovered, inventory]) => {
        if (!active) return
        setSkills(discovered)
        setLocalSkillInventory({ state: "available", inventory })
        setSkillInventories([{ state: "available", inventory }])
      },
      (cause: unknown) => {
        if (active) {
          setSkillInventories(skillMachine ? [{
            state: connected ? "unknown" : "unreachable",
            machine: skillMachine,
          }] : [])
          setSkillsError(cause instanceof Error ? cause.message : "Skill discovery failed")
        }
      },
    ).finally(() => {
      if (active) setSkillsLoading(false)
    })
    return () => {
      active = false
      refresh.abort()
    }
  }, [
    connected,
    getSkillInventory,
    listSkills,
    skillMachine,
    skillProjectKey,
    skillsRefresh,
    skillsWanted,
  ])

  useEffect(() => {
    if (surface !== "skills" || !connected || localSkillInventory?.state !== "available") return
    const refresh = new AbortController()
    const inventory = localSkillInventory.inventory
    // Comparison follows home enrollment. Each remote reader proves its own
    // client binding; no read can fall back to the machine credential store.
    void collectFleetInventories({
      local: inventory,
      fleet: fleetMachines(fleet?.entries ?? []).map((machine) => ({ ...machine, self: machine.id === inventory.machine.id })),
      signal: refresh.signal,
      open: async (machine, signal) => {
        if (machine.id !== homeMachineId) return accessSession.inventory(machine.id, signal)
        const deadline = Deadline.start(30_000)
        return { inventory: () => homeSkillInventory({ signal, deadline }), close: () => deadline.clear() }
      },
    }).then((inventories) => {
      if (!refresh.signal.aborted) setSkillInventories(inventories)
    }, () => {})
    return () => refresh.abort()
  }, [surface, connected, localSkillInventory, fleet, homeMachineId, homeSkillInventory, accessSession, admittedMachines])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? shell.clientWidth
      if (width < 1080) setDockCollapsed(true)
      // No sessions panel to collapse any more: the drawer is already out of
      // the layout, so a narrow window costs it nothing.
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  return (
    <TooltipProvider>
      <div ref={shellRef} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <AppBar sessionsDrawer={snapshot ? <SessionsDrawerTrigger snapshot={snapshot} open={sessionsOpen} onOpenChange={setSessionsOpen} /> : undefined} snapshot={snapshot} connected={connected} emergencyStopPending={emergencyStopPending} emergencyStopOutcome={emergencyStopOutcome} emergencyStopError={emergencyStopError} bridge={windowBridge} windowDecoration={activeWindowDecoration} onOpenProject={requestOpenProject} onPauseAll={pauseActiveTurns} onEmergencyStop={stopEverything} onOpenCommands={openCommandPalette} commandShortcut={commandPlatform === "darwin" ? "⌘K" : "Ctrl+K"} />
        <WorkspaceConnectionStatus
          connected={connected}
          reconnecting={reconnecting}
          authenticationRequired={authenticationRequired}
          protocolError={protocolError}
          connectionError={connectionError}
          machineName={snapshot?.machine.name}
          onChangeCredential={attached ? undefined : onChangeCredential}
          onReconnect={reconnectDaemon}
        />
        {attached ? <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-sm" role="status">
          <span>{!access ? "Client access is no longer verified for" : connected ? "Using" : "Connecting to"} <span className="font-machine">{fleetMachines(fleet?.entries ?? []).find((machine) => machine.id === attached.machineId)?.label ?? attached.machineId}</span>{access ? " with this app's client credential." : ". Return home and authorize this client again."}</span>
          <Button variant="outline" size="sm" onClick={() => setAttached(null)}>Return to home daemon</Button>
        </div> : null}
        {snapshot ? <div className="flex min-h-0 flex-1">
          <WorkspaceRail surface={surface} dockTab={dockTab} machineName={snapshot.machine.name} onSelectSurface={setSurface} onSelectDockTab={openDockTab} />
          {/* v2's drawer is a column beside whatever surface is open, so a
              session can be reached from Settings or the audit log too. */}
          <SessionsDrawerColumn
            snapshot={snapshot}
            open={sessionsOpen}
            onActivate={openSessionInWorkspace}
            onAction={sessionRowAction}
            onNewSession={() => snapshot.project ? setLauncherMode("session") : requestOpenProject()}
            onOpenProviderSettings={() => setSurface("providers")}
          />
          <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive {snapshot.sessions.find((session) => session.id === archiveTarget)?.title ?? "this session"}?</AlertDialogTitle>
                <AlertDialogDescription>{archiveSessionDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    const target = archiveTarget
                    setArchiveTarget(null)
                    if (target) void archiveSession(target).catch((cause: unknown) => setConnectionError(cause instanceof Error ? cause.message : "The session could not be archived"))
                  }}
                >
                  Archive session
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {surface === "providers" ? (
          <SettingsShell
            providers={snapshot.machine.providers}
            secrets={providerSecrets}
            {...(localDaemon && !attached ? { localDaemon } : {})}
            approvalRules={snapshot.approvalRules}
            notifications={notificationPreferences}
            onNotificationsChange={(next: NotificationPreferences) => {
              setWorkspaceUi((current) => ({ ...current, notifications: next }))
            }}
            {...(notificationDelivery && installState ? {
              clientCapabilities: {
                delivery: notificationDelivery,
                install: installState,
                onRequestDelivery: requestNotificationDelivery,
                onInstall: requestInstall,
              },
            } : {})}
            onOpenFleet={() => setSurface("fleet")}
            onOpenSkills={() => setSurface("skills")}
            onOpenAudit={() => setSurface("audit")}
            theme={theme}
            onThemeChange={(next: WorkspaceTheme) => {
              setWorkspaceUi((current) => ({ ...current, theme: next }))
            }}
            {...(firstRunEnabled ? { onResetFirstRun: resetFirstRun } : {})}
            {...(windowBridge ? {
              externalEditor,
              onExternalEditorChange: (editor: DesktopExternalEditor) => {
                setWorkspaceUi((current) => ({ ...current, externalEditor: editor }))
              },
            } : {})}
            {...(windowBridge ? {
              windowDecoration,
              activeWindowDecoration,
              onWindowDecorationChange: changeWindowDecoration,
            } : {})}
          />
        ) : surface === "skills" ? (
          <SkillBrowser
            skills={skills}
            inventorySources={skillInventories}
            loading={skillsLoading}
            error={skillsError}
            onOpenAudit={() => setSurface("audit")}
            onReadSkill={readSkill}
            requestedSkillId={requestedSkillId}
            projectId={snapshot.project?.id}
            enablements={snapshot.skillEnablements}
            onSetSkillEnabled={setSkillEnabled}
            onReviewSkill={async (input) => {
              const reviewed = await reviewSkill(input)
              setSkillsRefresh((current) => current + 1)
              return reviewed
            }}
            onPreviewSkillInstall={(source) => previewSkillInstall({ source })}
            onInstallSkill={async (input) => {
              const installed = await installSkill(input)
              setSkillsRefresh((current) => current + 1)
              return installed
            }}
            onRetry={() => setSkillsRefresh((current) => current + 1)}
          />
        ) : surface === "fleet" ? (
          <FleetView
            connected={home.connected}
            entries={fleet?.entries ?? (home.snapshot ? [localFleetEntry(home.snapshot)] : [])}
            fleetOverflow={fleetOverflow}
            clientKind={clientKind}
            clientAccess={clientAccess}
            onAuthorizeClient={(machineId, credential, signal) => accessSession.authorize(machineId, credential, signal)}
            onRemoveClientAccess={removeClientAccess}
            currentMachineId={attached?.machineId ?? snapshot.machine.id}
            currentSessionCount={activeSessionCount(snapshot)}
            onOpenSkills={() => setSurface("skills")}
            onListDevices={listDevices}
            onRevokeDevice={revokeDevice}
            onRotateDevice={rotateDevice}
            onRenameDevice={renameDevice}
            onPairMachine={pairMachine}
            onForgetMachine={async (machineId: string) => {
              const result = await forgetMachine({ machineId })
              if (result.outcome === "forgotten") removeClientAccess(machineId)
              return result
            }}
            onUseMachine={(machineId: string) => {
              switchMachine(machineId)
              setSurface("workspace")
            }}
            onOpenMachineTerminal={(machineId: string) => {
              switchMachine(machineId)
              setSurface("workspace")
              openDockTab("terminal")
            }}
          />
        ) : surface === "audit" ? (
          <AuditLogView
            connected={connected}
            onOpenSkills={() => setSurface("skills")}
            onQuery={queryAudit}
            onExport={exportAudit}
          />
        ) : (
          <div className="relative flex min-h-0 flex-1">
            <ResizablePanelGroup
              key={layoutKey}
              orientation="horizontal"
              className="min-h-0 min-w-0 flex-1"
              {...(defaultLayout ? { defaultLayout } : {})}
              onLayoutChanged={(layout, meta) => {
                if (!meta.isUserInteraction) return
                setWorkspaceUi((current) => ({
                  ...current,
                  layouts: { ...current.layouts, [layoutKey]: layout },
                }))
              }}
            >
              <ResizablePanel id="thread" defaultSize={dockCollapsed ? "100" : "48"} minSize="34"><Thread key={activeThreadKey(snapshot)} snapshot={snapshot} connected={connected} emergencyStopPending={emergencyStopPending} queued={snapshot.activeSessionId ? queues[snapshot.activeSessionId] : undefined} onQueuedChange={(next) => snapshot.activeSessionId ? setQueues((current) => setQueue(current, snapshot.activeSessionId!, next)) : undefined} failures={failures} onDismissFailure={(id) => setFailures((current) => current.filter((attempt) => attempt.id !== id))} onResolve={resolveApproval} onSetRuntime={(runtime) => snapshot.activeSessionId ? setRuntime(snapshot.activeSessionId, runtime) : Promise.reject(new Error("No session is active"))} onRestartProviderThread={() => snapshot.activeSessionId ? restartProviderThread(snapshot.activeSessionId) : Promise.reject(new Error("No session is active"))} onForkSession={forkSession} onListModels={listModels} onNewSession={() => snapshot.project ? setLauncherMode("session") : requestOpenProject()} onSend={sendMessage} onCheckpoint={createCheckpoint} onRestoreCheckpoint={restoreCheckpointGuarded} restoreBusy={checkpointRestorePending} pendingTransferTargetId={launcherTransferTargetId} onPendingTransferTargetChange={setLauncherTransferTargetId} onPauseSession={pauseSession} onArchiveSession={archiveSession} onPairMachine={attached ? undefined : pairMachine} fleet={fleet?.entries} transferFleet={attached ? remote.fleet?.entries ?? [] : fleet?.entries} admittedMachines={admittedMachines} currentMachineId={attached?.machineId ?? snapshot.machine.id} onSelectMachine={switchMachine} onTransferSession={transferSession} onPreviewTransfer={previewTransfer} onReleaseSession={releaseSession} externalEditor={externalEditor} usage={activeSessionUsage} usageToday={usageToday} loadLatestTurn={loadLatestTurn} machineMenuRequest={machineMenuRequest} onDiscoverRuntime={discoverRuntime} onEditPlan={editPlan} onDiscardPlanEdit={discardPlanEdit} onOpenPlanPreview={() => openDockTab("plan")} onOpenSkills={() => setSurface("skills")} skillNames={Object.fromEntries(skills.map((skill) => [skill.id, skill.name]))} skillCatalog={skills} {...(windowBridge && !attached ? { onOpenExternal: (path: string) => openDesktopPath(windowBridge, path, externalEditor) } : {})} /></ResizablePanel>
              {!dockCollapsed && dockPinned ? <><ResizableHandle withHandle aria-label="Resize thread and artifact dock" /><ResizablePanel id="dock" defaultSize={280} minSize="24" maxSize="46">{machineSurfaces}</ResizablePanel></> : null}
            </ResizablePanelGroup>
            {!dockCollapsed && !dockPinned ? (
              <MachineSheet
                open
                pinned={false}
                pinButtonRef={sheetPinButtonRef}
                openerRef={dockOpenerRef}
                onClose={() => setDockCollapsed(true)}
                onTogglePin={() => setDockPinned(true)}
              >
                {machineSurfaces}
              </MachineSheet>
            ) : null}
            {!dockCollapsed && dockPinned ? (
              <div className="absolute top-2 right-3 z-10">
                <Button ref={dockUnpinButtonRef} variant="ghost" size="sm" aria-pressed onClick={() => setDockPinned(false)}>Unpin</Button>
              </div>
            ) : null}
            {dockCollapsed ? <DockRail onExpand={() => setDockCollapsed(false)} expandButtonRef={dockExpandButtonRef} /> : null}
          </div>
          )}
        </div> : (
          // The design draws this as skeletons in the shape of what is coming
          // rather than a centred sentence, so the sidebar and thread do not
          // appear from nothing and shift the layout under a cursor. The line
          // naming the machine stays: a shape alone would claim rows are
          // definitely coming, and the daemon has not said so yet.
          <main className="flex min-h-0 flex-1 bg-background">
            <h1 className="sr-only">Connecting to the daemon</h1>
            <div className="flex w-[var(--shell-sidebar)] shrink-0 flex-col border-r bg-sidebar">
              <SessionListSkeleton reading={readingLabel} />
            </div>
            <ThreadSkeleton reading={readingLabel} />
          </main>
        )}
        {workspaceError ? (
          <Alert
            variant="destructive"
            className="absolute bottom-3 left-3 z-50 w-auto max-w-sm shadow-[var(--shadow-md)]"
          >
            <CircleStopIcon />
            <AlertTitle>Workspace action failed</AlertTitle>
            <AlertDescription>{workspaceError}</AlertDescription>
          </Alert>
        ) : null}
        {snapshot ? <LauncherDialog
          mode={launcherMode}
          {...(launcherProjectNote ? { projectNote: launcherProjectNote } : {})}
          providers={snapshot.machine.providers}
          {...(desktopFirstRun.persisted.status === "complete"
            ? { defaultProviderId: desktopFirstRun.persisted.providerId }
            : {})}
          defaultPermissionMode={desktopFirstRun.persisted.status === "complete"
            ? desktopFirstRun.persisted.permissionMode
            : "build"}
          onOpenChange={(open) => { if (!open) setLauncherMode(null) }}
          onOpenProject={openProjectSafely}
          onCreateSession={createSession}
          onListModels={listModels}
        /> : null}
        {projectSwitchConfirmation ? (
          <ProjectSwitchConfirmationDialog
            confirmation={projectSwitchConfirmation}
            pending={projectSwitchPending}
            error={projectSwitchError}
            onCancel={() => {
              setProjectSwitchError("")
              setProjectSwitchConfirmation(null)
            }}
            onConfirm={(path) => { void confirmProjectSwitch(path) }}
          />
        ) : null}
        <CommandPalette
          open={commandPaletteOpen}
          platform={commandPlatform}
          commands={workspaceCommands}
          onOpenChange={setCommandPaletteOpen}
          restoreFocusTo={commandPaletteFocusRef.current}
          {...(firstRunEnabled ? {
            onOpenFirstRun: () => setDesktopFirstRun((current) => ({ ...current, open: true })),
          } : {})}
        />
        {firstRunEnabled ? (
          <DesktopFirstRunDialog
            open={desktopFirstRun.open}
            connected={connected}
            {...(snapshot ? {
              machine: {
                name: snapshot.machine.name,
                platform: snapshot.machine.platform,
                version: snapshot.machine.version,
              },
            } : {})}
            providers={snapshot?.machine.providers ?? []}
            sessions={snapshot?.sessions ?? []}
            selectedProviderId={desktopFirstRun.selectedProviderId}
            permissionMode={desktopFirstRun.permissionMode}
            refreshing={desktopFirstRun.refreshing}
            recoveryError={desktopFirstRun.error}
            onProviderChange={(selectedProviderId) => {
              setDesktopFirstRun((current) => ({ ...current, selectedProviderId, error: "" }))
            }}
            onPermissionModeChange={(permissionMode) => {
              setDesktopFirstRun((current) => ({ ...current, permissionMode }))
            }}
            onRetry={retryDesktopFirstRun}
            onCopyGuidance={copyFirstRunGuidance}
            onSkip={() => setDesktopFirstRun((current) => ({ ...current, open: false }))}
            onComplete={completeFirstRun}
          />
        ) : null}
      </div>
    </TooltipProvider>
  )
}
