import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import {
  ArchiveIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  BotIcon,
  CheckIcon,
  CircleStopIcon,
  FolderOpenIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  PaperclipIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import type {
  ApprovalRequest,
  ApprovalDecision,
  ClientAccess,
  ProviderFailure,
  PermissionMode,
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
import { selectableTurnSkills, threadFollowPillText, sessionTransferRefusalMessage, turnSkillSelectionFor } from "@getdomovoi/protocol"
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { sessionDraftStore } from "./session-draft"
import { useThreadFollow } from "./thread-follow"
import { composerPlaceholder, composerPlatform, sendHint } from "./composer-keys"
import { Textarea } from "./components/ui/textarea"
import { MachineSwitcher } from "./machine-switcher.js"
import { fleetMachines } from "./fleet-entries.js"
import { PairMachineDialog } from "./pair-machine-dialog.js"
import { TransferSessionDialog } from "./transfer-session-dialog.js"
import type { PairedMachine, PairMachineRequest } from "./pair-machine.js"
import { cn } from "./lib/utils"
import { DomovoiMark } from "./domovoi-mark"
import { ApprovalReceipt } from "./approval-receipt"
import { PlanStrip } from "./plan-strip"
import { ModelPopover } from "./model-popover.js"
import { FloatingSurface } from "./floating-surface"
import { ModeChip } from "./mode-chip.js"
import { permissionModeLabel, withPermissionMode } from "./permission-mode.js"
import type { WorkingPlanEdit } from "./plan-step-editor.js"
import { groupThreadActivity, type ThreadRow } from "./thread-activity-groups"
import { TurnActivity } from "./turn-activity"
import { CheckpointRestore, checkpointRestoreBlocked } from "./checkpoint-actions.js"
import { UsageChip } from "./usage-chip.js"
import {
  deliveryLabel,
  heldAfter,
  submitFromComposer,
  type FailedAttempt,
  type QueuedMessage,
} from "./turn-queue"
import { PromptDeliveryNote } from "./prompt-delivery-note"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { MarkdownQuickView } from "./markdown-quick-view"
import { PromptEditorDialog } from "./prompt-editor"
import { desktopExternalActionLabel, type DesktopExternalEditor } from "./desktop-platform"
import {
  activeSessionCount,
  activeThreadKey,
  forkSessionBlockedReason,
  localFleetEntry,
  localMachineEntry,
  renderedThreadForActiveSession,
  sessionIsArchiveReadOnly,
} from "./workspace-selectors"
import { restoreFocusAfterUpdate } from "./restore-focus"
import { FailedReadState } from "./failed-read-state"
import { PolicyRefusalCard } from "./policy-refusal-card"
import {
  attachmentFromBrowserFile,
  attachmentMeta,
  attachmentName,
  desktopAttachmentLimit,
  inlineTextPreview,
  terminalOutputAttachment,
  workspacePathAttachment,
} from "./desktop-attachments"

type SlashCommand = {
  name: string
  argument: string
  note: string
}

const slashCommands: readonly SlashCommand[] = [
  {
    name: "/run",
    argument: "pnpm prisma migrate deploy",
    note: "Runs it now, in the worktree. Still gated if no rule covers it, and the gate says the request came from you.",
  },
  {
    name: "/revert",
    argument: "ckpt_7f24",
    note: "Rewinds the worktree and the thread together to that checkpoint. Nothing merged is touched.",
  },
  {
    name: "/replan",
    argument: "from step 3",
    note: "Keeps the finished steps and asks for a new plan for the rest. The old plan stays readable in the thread.",
  },
  {
    name: "/mode",
    argument: "plan · ask · build",
    note: "Applies from the next turn. A turn already in flight keeps the mode it started with, and auto is only legal with build.",
  },
  {
    name: "/skill",
    argument: "pr-triage",
    note: "Loads a skill for this turn only. Unsigned skills stay blocked in auto modes.",
  },
  {
    name: "/handoff",
    argument: "hetzner-cx42",
    note: "Opens the pre-flight checks first. Nothing moves until they pass and you confirm.",
  },
]

type SlashIntent =
  | { kind: "send", prompt: string }
  | { kind: "mode", permissionMode: PermissionMode }
  | { kind: "revert", checkpointId: string }
  | { kind: "skill", skillId: string }
  | { kind: "handoff", machineId: string }
  | { kind: "invalid", message: string }

type SlashIntentContext = {
  checkpointIds: readonly string[]
  skills: readonly { id: string, name: string }[]
  machines: readonly { id: string, label: string, self: boolean }[]
}

const slashUsage = {
  run: "Usage: /run <command>",
  revert: "Usage: /revert <checkpoint-id>. Choose a checkpoint from this active session.",
  replan: "Usage: /replan [from step N]",
  mode: "Usage: /mode <plan|ask|build>",
  skill: "Usage: /skill <reviewed-skill>",
  handoff: "Usage: /handoff <target-machine>",
} as const

function oneMatch<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  const matched = items.filter(matches)
  return matched.length === 1 ? matched[0] : undefined
}

function slashIntent(input: string, context: SlashIntentContext): SlashIntent {
  const trimmed = input.trim()
  const separator = trimmed.search(/\s/u)
  const command = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase()
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim()
  switch (command) {
    case "/run":
      return argument
        ? { kind: "send", prompt: `Run this command in the worktree:\n\n${argument}` }
        : { kind: "invalid", message: slashUsage.run }
    case "/replan":
      return {
        kind: "send",
        prompt: argument
          ? `Replan the remaining work ${argument}${/[.!?]$/u.test(argument) ? "" : "."}`
          : "Replan the remaining work while preserving completed steps and prior plan history.",
      }
    case "/mode":
      return argument === "plan" || argument === "ask" || argument === "build"
        ? { kind: "mode", permissionMode: argument }
        : { kind: "invalid", message: slashUsage.mode }
    case "/revert": {
      const checkpoint = oneMatch(context.checkpointIds, (id) => id === argument)
      return checkpoint
        ? { kind: "revert", checkpointId: checkpoint }
        : { kind: "invalid", message: slashUsage.revert }
    }
    case "/skill": {
      const normalized = argument.toLowerCase()
      const skill = oneMatch(context.skills, (candidate) =>
        candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized
      )
      return skill
        ? { kind: "skill", skillId: skill.id }
        : { kind: "invalid", message: slashUsage.skill }
    }
    case "/handoff": {
      const normalized = argument.toLowerCase()
      const machine = oneMatch(context.machines, (candidate) =>
        !candidate.self && (candidate.id.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized)
      )
      return machine
        ? { kind: "handoff", machineId: machine.id }
        : { kind: "invalid", message: slashUsage.handoff }
    }
    default:
      return { kind: "invalid", message: "Usage: /run, /revert, /replan, /mode, /skill, or /handoff" }
  }
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
  surface,
}: {
  approval: ApprovalRequest
  onResolve: (
    decision: ApprovalDecision,
    explanation?: string,
  ) => void
  surface: "desktop" | "web"
}) {
  const explainTriggerRef = useRef<HTMLButtonElement>(null)
  const [explainOpen, setExplainOpen] = useState(false)
  const [explanation, setExplanation] = useState("")

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
    <Alert variant="warning" className="mx-auto max-w-3xl gap-3 rounded-xl p-4">
      <CircleStopIcon />
      <AlertTitle className="flex items-center gap-2 text-[12.5px]">
        {surface === "web" && approval.risk === "hard-gate" ? "Approval required, hard gate" : "Approval required"}
        {surface === "desktop" && approval.risk === "hard-gate" ? <Badge variant="warning">Hard gate</Badge> : null}
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
              <Button variant="outline" size="sm" onClick={() => onResolve("deny")}>Deny without explanation</Button>
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
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="warning" size="sm" onClick={() => onResolve("allow-once")}>Allow once</Button>
            <Button variant="outline" size="sm" onClick={() => onResolve("always-project")}>{surface === "web" ? "Always here" : "Always in this project"}</Button>
            <Button ref={explainTriggerRef} variant="outline" size="sm" onClick={() => setExplainOpen(true)}>Deny</Button>
            {surface === "web" ? <span className="ml-auto font-machine text-[10.5px] text-warn-dim">This tab holds the gate</span> : null}
          </div>
        )}
      </AlertDescription>
    </Alert>
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
  // v2 draws no archive control in the composer, so nothing here calls this.
  // The prop stays because the shell and the tests still pass it, and dropping
  // it would be a rename of Thread's surface rather than a design change.
  onArchiveSession?: (sessionId: string) => Promise<void>
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
  onOpenSheet?: (() => void) | undefined
  // Bumped by the sessions drawer's "Move to another machine" so the composer's
  // machine menu opens on the session it just activated.
  machineMenuRequest?: number | undefined
  onOpenSkills?: (() => void) | undefined
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
  const [attachmentPathMode, setAttachmentPathMode] = useState<"repo" | "machine" | null>(null)
  const [attachmentPath, setAttachmentPath] = useState("")
  const [attachmentError, setAttachmentError] = useState("")
  const attachmentInput = useRef<HTMLInputElement>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const composerField = useRef<HTMLTextAreaElement>(null)
  const composerCard = useRef<HTMLDivElement>(null)
  const slashListId = useId()
  const slashQuery = prompt.split(/\s/u, 1)[0] ?? ""
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
  // A turn that has not called a tool yet still has to say it is alive. Once a
  // tool row runs, that row carries the pulse and a second one would say the
  // same thing twice.
  const workingRow = Boolean(active?.activeTurnId)
    && !threadRows.some((row) => row.kind === "activity" && row.items.some((call) => call.outcome === "running"))
  const follow = useThreadFollow(threadViewport, {
    itemCount: threadRows.length + (approval ? 1 : 0),
    gated: Boolean(approval),
    threadKey: activeThreadKey(snapshot),
  })
  const followPill = threadFollowPillText(follow.state, follow.unseen)
  const [skillSelection, setSkillSelection] = useState<ReadonlySet<string> | undefined>(() => sessionDraftStore.read(draftSessionId).skillSelection)
  const [promptEditorOpen, setPromptEditorOpen] = useState(() => sessionDraftStore.read(draftSessionId).promptEditorOpen)
  // A send clears the prompt, which writes an empty draft, which the store reads
  // as no draft at all. So nothing has to clear it by hand.
  useEffect(() => {
    sessionDraftStore.write(draftSessionId, { prompt, attachments, skillSelection, promptEditorOpen })
  }, [draftSessionId, prompt, attachments, skillSelection, promptEditorOpen])
  const [pairingMachine, setPairingMachine] = useState(false)
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
  const [pending, setPending] = useState(false)
  // Local only, and never a thread item. The daemon owns the thread, so an
  // in-flight message is shown beside it as a note, not forged into it.
  const [sending, setSending] = useState<string | null>(null)
  const [runtimePending, setRuntimePending] = useState(false)
  const [sendError, setSendError] = useState("")
  const [recoveryError, setRecoveryError] = useState("")
  const [runtimeError, setRuntimeError] = useState("")
  const [restartPending, setRestartPending] = useState(false)
  const [restartError, setRestartError] = useState("")
  const [desktopError, setDesktopError] = useState("")
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
  const addAttachments = (next: SessionAttachment[]) => {
    const combined = [...attachments, ...next]
    if (combined.length > desktopAttachmentLimit) {
      setAttachmentError(`Attach up to ${desktopAttachmentLimit} items per message.`)
      return
    }
    setAttachmentError("")
    setAttachments(combined)
  }
  const attachWorkspacePath = () => {
    try {
      addAttachments([workspacePathAttachment(attachmentPath)])
      setAttachmentPath("")
      setAttachmentPathMode(null)
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "That path cannot be attached")
    }
  }
  const attachClipboardOutput = async () => {
    try {
      const content = await navigator.clipboard.readText()
      addAttachments([terminalOutputAttachment(content)])
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "Terminal output could not be read from the clipboard")
    }
  }
  // The Think chip offers what the current model reports. The catalog is read
  // once per provider change; a read that fails leaves the chip shut with its
  // reason rather than offering a guess. Hooks sit above the no-session return.
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
            <Button disabled={watching} onClick={onNewSession}>
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
      readOnly={readOnly}
      {...(onEditPlan ? { onEditPlan: (edit: WorkingPlanEdit) => onEditPlan(active.id, edit) } : {})}
      {...(onDiscardPlanEdit ? { onDiscardEdit: (editId: string) => onDiscardPlanEdit(active.id, editId) } : {})}
      {...(onOpenPlanPreview ? { onOpenPreview: onOpenPlanPreview } : {})}
      className="mx-auto mb-2 max-w-[var(--shell-thread)]"
    />
  )

  const paletteShortcut = composerPlatform() === "darwin" ? "⌘K" : "Ctrl+K"
  const takeSlashCommand = (command: SlashCommand) => {
    if (watching) return
    const accepted = `${command.name} `
    setPrompt(accepted)
    setSlashDismissed(true)
    queueMicrotask(() => {
      const field = composerField.current
      field?.focus()
      field?.setSelectionRange(accepted.length, accepted.length)
    })
  }
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
      const intent = slashIntent(prompt, {
        checkpointIds: activeCheckpointIds,
        skills: selectableSkills,
        machines,
      })
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

  const pauseSession = async () => {
    if (watching || pending || !active.activeTurnId) return
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
    if (watching || runtimePending) return
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

  const resolveCurrentApproval = (
    approvalId: string,
    decision: ApprovalDecision,
    explanation?: string,
  ) => {
    if (watching) return
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
        ) : !watching ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
            {active.workspacePath && onOpenExternal ? (
              <Button variant="outline" size="sm" onClick={() => void openExternal()}>
                <ExternalLinkIcon data-icon="inline-start" />
                {desktopExternalActionLabel(externalEditor)}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportRef={threadViewport} onViewportScroll={follow.onScroll}>
        <div className="mx-auto flex w-full max-w-[668px] flex-col gap-5 px-6 pt-6 pb-14">
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
            if (item.kind === "system") {
              return <Alert key={item.id} className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"><BotIcon /><AlertTitle>System</AlertTitle><AlertDescription><MarkdownQuickView source={[item.body, item.detail].filter(Boolean).join("\n\n")} /></AlertDescription></Alert>
            }
            if (item.kind === "receipt") {
              return <ApprovalReceipt key={item.id} receipt={item} />
            }
            if (item.kind === "policy-refusal") {
              return <PolicyRefusalCard key={item.id} refusal={item} />
            }
            if (item.kind === "tool") return null
            return <div key={item.id} className="flex max-w-2xl gap-3"><span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border bg-card text-primary"><DomovoiMark reduced className="size-4" /></span><MarkdownQuickView source={item.body} /></div>
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
          {approval && !readOnly ? <ApprovalCard surface={surface} approval={approval} onResolve={(decision, explanation) => resolveCurrentApproval(approval.id, decision, explanation)} /> : null}
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
        {desktopError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Desktop action failed</AlertTitle><AlertDescription>{desktopError}</AlertDescription></Alert> : null}
        {runtimeError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Runtime update failed</AlertTitle><AlertDescription>{runtimeError}</AlertDescription></Alert> : null}
        {sendError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Agent request failed</AlertTitle><AlertDescription>{sendError}</AlertDescription></Alert> : null}
        {recoveryError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[var(--shell-thread)]"><CircleStopIcon /><AlertTitle>Session could not be released</AlertTitle><AlertDescription>{recoveryError}</AlertDescription></Alert> : null}
        {planStrip}
        <div ref={composerCard} data-workspace-composer="" className={cn(
          "relative mx-auto flex max-w-[var(--shell-thread)] flex-col gap-[11px] rounded-[16px] border bg-card pt-[13px] pr-[15px] pb-[11px] pl-[15px]",
          readOnly && "[&_button:disabled]:opacity-[.45]",
        )}>
          {watching ? (
            <div className="flex items-start gap-2.5 rounded-[calc(var(--radius)-2px)] border border-info-border bg-info-background px-3 py-[11px]">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] leading-[1.5] text-info-foreground">Free plan: this route carries reads only.</div>
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
          {(failures ?? []).filter((attempt) => attempt.sessionId === active.id).map((attempt) => (
            <div key={attempt.id} className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-background px-3 py-2">
              <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-danger-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-danger-foreground">{attempt.text}</span>
              <span className="text-[10.5px] whitespace-nowrap text-danger-dim">{deliveryLabel(attempt)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readOnly}
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
              <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => onDismissFailure?.(attempt.id)}>Dismiss</Button>
            </div>
          ))}
          {sending !== null ? (
            <div role="status" aria-label="Sending" className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
              <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-faint" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-strong">{sending}</span>
              <span className="font-machine text-[10.5px] whitespace-nowrap text-faint">sending</span>
            </div>
          ) : null}
          {queued?.sessionId === active.id ? (
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
              <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-faint" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-strong">{queued.text}</span>
              <span className="font-machine text-[10.5px] whitespace-nowrap text-faint">
                {queued.state === "held"
                  ? queued.reason ?? "held"
                  : active.activeTurnId ? "queued, sends when this turn ends" : "queued"}
              </span>
              {queued.state === "held" ? (
                <Button variant="ghost" size="sm" disabled={readOnly || Boolean(active.activeTurnId) || pending || emergencyStopPending || providerRestartRequired} onClick={() => onQueuedChange({ ...queued, state: "waiting" })}>Send</Button>
              ) : null}
              <Button variant="ghost" size="icon-sm" aria-label="Unqueue the message" className="size-6 flex-none text-faint" disabled={readOnly} onClick={() => onQueuedChange(undefined)}><XIcon className="size-3" /></Button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div role="region" className="flex min-w-0 items-center gap-[7px] overflow-hidden" aria-label="Attachments">
              {attachments.map((attachment, index) => {
                return (
                  <div key={`${attachmentName(attachment)}-${index}`} className="flex min-w-0 max-w-[260px] items-center gap-[7px] rounded-md border bg-background px-2 py-1">
                    <span className="font-machine text-[10.5px] text-primary">{"kind" in attachment && attachment.kind === "text" ? "TXT" : "FILE"}</span>
                    <span className="min-w-0 truncate font-machine text-[10.5px] text-strong">{attachmentName(attachment)}</span>
                    <span className="font-machine text-[10px] text-faint">{attachmentMeta(attachment)}</span>
                    <Button variant="ghost" size="icon-sm" className="size-5 flex-none text-faint" aria-label={`Remove ${attachmentName(attachment)}`} onClick={() => setAttachments((current) => current.filter((_, candidate) => candidate !== index))}><XIcon className="size-3" /></Button>
                  </div>
                )
              })}
            </div>
          ) : null}
          {attachments.some((attachment) => Boolean(inlineTextPreview(attachment))) ? (
            <p className="m-0 text-[10.5px] leading-[1.45] text-warning">Too long to send inline. The prompt carries the first 40 lines, the agent reads the rest on request.</p>
          ) : null}
          {attachmentPathMode ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                aria-label={attachmentPathMode === "repo" ? "File in this repo" : `Path on ${snapshot.machine.name}`}
                value={attachmentPath}
                onChange={(event) => setAttachmentPath(event.target.value)}
                placeholder={attachmentPathMode === "repo" ? "src/path/to/file.ts" : "relative/path/on/machine"}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); attachWorkspacePath() } }}
              />
              <Button type="button" size="sm" disabled={!attachmentPath.trim()} onClick={attachWorkspacePath}>Attach</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAttachmentPathMode(null)}>Cancel</Button>
            </div>
          ) : null}
          <input
            ref={attachmentInput}
            type="file"
            accept="image/png,image/jpeg,text/plain,.md,.json,.csv,.log"
            className="sr-only"
            aria-label="Choose an image or file"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.currentTarget.value = ""
              void Promise.all(files.map(attachmentFromBrowserFile)).then(addAttachments, (cause: unknown) => {
                setAttachmentError(cause instanceof Error ? cause.message : "The file could not be attached")
              })
            }}
          />
          {attachmentError ? <p role="alert" className="m-0 text-[11px] text-destructive">{attachmentError}</p> : null}
          {slashOpen ? (
            <div aria-hidden className="flex min-h-[22px] items-center gap-px">
              <span className="font-machine text-[13.5px] text-foreground">{prompt}</span>
              <span className="h-[15px] w-[1.5px] bg-primary animate-[dv-composer-caret_1.1s_steps(1)_infinite]" />
            </div>
          ) : null}
          <Textarea
            ref={composerField}
            aria-label="Message"
            aria-expanded={slashOpen}
            aria-controls={slashOpen ? slashListId : undefined}
            rows={2}
            disabled={readOnly}
            // v2 draws the field with no box of its own: it sits straight on
            // the card. The dark variant on the shared Textarea has to be
            // turned off by name, or it paints a panel the design never draws.
            className={slashOpen
              ? "sr-only"
              : "max-h-[172px] min-h-[22px] resize-none overflow-y-auto border-0 bg-transparent p-0 text-[13.5px] leading-[1.6] shadow-none [field-sizing:content] focus-visible:ring-0 dark:bg-transparent"}
            placeholder={surface === "web" && connected
              ? "Steer it, or queue the next message"
              : composerPlaceholder({ offline: !connected, working: Boolean(active.activeTurnId) })}
            value={prompt}
            onChange={(event) => {
              const next = event.target.value
              setPrompt(next)
              if (!next.startsWith("/")) setSlashDismissed(false)
            }}
            onKeyDown={(event) => {
              // Enter sends, as the hint beside the send control says. Shift
              // keeps the newline, and the old modifier still sends so a hand
              // trained on it is not left pressing a dead key.
              if (event.key !== "Enter" || event.shiftKey) return
              event.preventDefault()
              void submitPrompt()
            }}
          />
          <FloatingSurface
            open={slashOpen}
            onClose={() => setSlashDismissed(true)}
            label="Slash commands"
            placement="above"
            trigger={composerCard}
            className="w-[380px] overflow-hidden rounded-[calc(var(--radius)-2px)] p-0"
          >
            <div
              id={slashListId}
              role="listbox"
              aria-labelledby={`${slashListId}-label`}
            >
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <span id={`${slashListId}-label`} className="text-[10.5px] font-medium tracking-[.13em] text-faint">THIS TURN</span>
                <span className="flex-1" />
                <span className="text-[11px] text-faint">{paletteShortcut} to go somewhere</span>
              </div>
              <div className="max-h-[216px] overflow-y-auto">
                {slashCommands.map((command) => {
                  const match = command.name.startsWith(slashQuery)
                  return (
                    <button
                      key={command.name}
                      type="button"
                      role="option"
                      aria-label={`${command.name} ${command.argument}`}
                      aria-selected={false}
                      data-match={match}
                      title={command.note}
                      onClick={() => takeSlashCommand(command)}
                      className={cn(
                        "flex h-8 w-full cursor-pointer items-center gap-2.5 border-t px-3 text-left first:border-t-0",
                        !match && "opacity-50",
                      )}
                    >
                      <span className={cn(
                        "w-[70px] flex-none font-machine text-[11.5px]",
                        match ? "text-primary" : "text-muted-foreground",
                      )}>{command.name}</span>
                      <span className="min-w-0 flex-1 truncate font-machine text-[10.5px] text-faint">{command.argument}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </FloatingSurface>
          <div data-workspace-composer-actions="" className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Attach" className="size-7 rounded-full" disabled={readOnly || attachments.length >= desktopAttachmentLimit}>
                    <PaperclipIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-[400px] p-0">
                  <DropdownMenuItem aria-label="File in this repo" className="items-start gap-[11px] rounded-none px-[13px] py-[11px]" onSelect={() => setAttachmentPathMode("repo")}>
                    <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">TS</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-foreground">File in this repo</span>
                      <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">A path in the worktree. Nothing is copied, the agent reads it where it is.</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem aria-label={`Path on ${snapshot.machine.name}`} className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px]" onSelect={() => setAttachmentPathMode("machine")}>
                    <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">DIR</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-foreground">Path on {snapshot.machine.name}</span>
                      <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">Anything else on that machine, including files outside the project. Reading outside the project asks first.</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem aria-label="Image or file from this device" className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px]" onSelect={() => attachmentInput.current?.click()}>
                    <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">FILE</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-foreground">Image or file from this device</span>
                      <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">The selected file is copied to {snapshot.machine.name} with the next message.</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem aria-label="Paste terminal output" className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px]" onSelect={() => void attachClipboardOutput()}>
                    <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">LOG</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-foreground">Paste terminal output</span>
                      <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">Pasted text, kept as a file in the session rather than inline in the message.</span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* v2's model chip follows the attachment control and opens the flat,
                  searchable list of what every harness here reports. */}
              <ModelPopover
                runtime={active.runtime}
                providers={snapshot.machine.providers}
                machineName={snapshot.machine.name}
                pending={runtimePending || readOnly}
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
              <ModeChip runtime={active.runtime} pending={runtimePending || readOnly} onSetRuntime={(runtime) => void updateRuntime(runtime)} />
              {/* v2 opens the machine surfaces from the row itself, on Changes.
                  It is the only control here that looks at the machine rather
                  than at what the next turn sends. */}
              {onOpenSheet ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open the sheet"
                  className="size-7 flex-none rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={onOpenSheet}
                >
                  <TerminalIcon className="size-4" />
                </Button>
              ) : null}
              {/* The editor is the same draft in a larger field. v2 draws its
                  control here, beside the surfaces it runs against, not out at
                  the send end of the row. */}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Expand prompt editor"
                className="size-7 flex-none rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                disabled={readOnly}
                onClick={() => setPromptEditorOpen(true)}
              >
                <Maximize2Icon className="size-4" />
              </Button>
              {/* v2 draws no checkpoint control in the composer. /revert
                  rewinds to one, and the Checkpoints sheet tab lists them. */}
              {/* Archiving lives on the session's own row in the drawer, which
                  asks with these same words. v2 draws no archive control in
                  the composer, so this row no longer carries a second one. */}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* v2's usage chip belongs to the composer, at the right of its
                  action row. The sidebar reorganisation moves the row with it. */}
              <UsageChip usage={usage} today={usageToday} loadLatestTurn={loadLatestTurn} />
              <span role="status" className="flex flex-col items-end font-machine text-mono-xs leading-[1.35] text-faint">
                {providerRestartRequired
                  ? <span>Restart the provider before sending</span>
                  : sendHint(composerPlatform()).split(" · ").map((line) => (
                      <span key={line} className="whitespace-nowrap">{line}</span>
                    ))}
              </span>
              {/* v2 draws stop as a 28px round bordered control beside send,
                  not as a labelled button out among the chips. */}
              {active.activeTurnId ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Stop the agent"
                        className="size-7 flex-none rounded-full"
                        disabled={readOnly || pending || !connected}
                        onClick={() => void pauseSession()}
                      >
                        <SquareIcon className="size-2.5 fill-current" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} className="block w-[220px] bg-card px-[11px] py-[9px] text-foreground ring-1 ring-border">
                      <span className="block text-[11.5px]">Stop the agent</span>
                      <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">Ends this turn at its next tool boundary. The session, plan and worktree stay as they are.</span>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}<Button size="icon-sm" className="rounded-full" aria-label="Send message" disabled={readOnly || !prompt.trim() || pending || !connected || providerRestartRequired || emergencyStopPending} onClick={() => void submitPrompt()}><ArrowUpIcon /></Button></div>
          </div>
          {!readOnly ? (
            <div className="sr-only">
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
            </div>
          ) : null}
          {!readOnly && onPairMachine ? (
            <PairMachineDialog
              open={pairingMachine}
              onOpenChange={setPairingMachine}
              onClaim={onPairMachine}
              onPaired={() => setPairingMachine(false)}
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
            />
          ) : null}
        </div>
        {!readOnly ? (
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
            turnRunning={Boolean(active.activeTurnId)}
            machineName={snapshot.machine.name}
            machineReachable={snapshot.machine.reachable}
            modelLabel={active.runtime.model}
            modeLabel={permissionModeLabel(active.runtime.permissionMode, active.runtime.auto).toLowerCase()}
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
