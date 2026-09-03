import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react"
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  CodeXmlIcon,
  FileDiffIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LaptopIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  MinusIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  PrinterIcon,
  SearchIcon,
  Maximize2Icon,
  SendIcon,
  SettingsIcon,
  SquareIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react"

import type {
  ApprovalRequest,
  ApprovalDecision,
  Annotation,
  Artifact,
  ArtifactAccess,
  ClientKind,
  PermissionMode,
  ProviderFailure,
  ProviderModel,
  ProviderRuntime,
  ProjectSwitchConfirmation,
  RpcParams,
  Runtime,
  SessionEvidence,
  FleetMachine,
  SessionHistoryCategory,
  SessionHistoryPage,
  SessionSummary,
  SessionTransferParams,
  SessionTransferResult,
  SkillSummary,
  SkillInventorySource,
  SessionUsage,
  SystemEmergencyStopResult,
  ThreadItem,
  WorkspaceSnapshot,
  PreviewBridgePickerMessage,
  PreviewBridgeResolveAnchorsMessage,
  PreviewBridgeSelectionMessage,
} from "@getdomovoi/protocol"
import { boundedClientThread, protocolVersion, sessionTransferRefusalMessage } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./components/ui/field"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable"
import { ScrollArea, ScrollBar } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { Switch } from "./components/ui/switch"
import { Textarea } from "./components/ui/textarea"
import { MachineSwitcher } from "./machine-switcher.js"
import { connectMachineClient } from "./machine-client.js"
import { collectFleetInventories } from "./fleet-inventories.js"
import { openMachine } from "./open-machine.js"
import { resolveMachineTarget } from "./machine-target.js"
import {
  attachedMachineSwitch,
  beganMachineSwitch,
  failedMachineSwitch,
  homeMachineSwitch,
  type MachineSwitchState,
} from "./machine-switch-state.js"
import { PairMachineDialog } from "./pair-machine-dialog.js"
import { TransferSessionDialog } from "./transfer-session-dialog.js"
import type { PairedMachine, PairMachineRequest } from "./pair-machine.js"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { cn } from "./lib/utils"
import { artifactUrlFor } from "./artifact-url"
import { ProjectSwitchConfirmationError } from "./client"
import { useWorkspace } from "./use-workspace"
import { DomovoiMark } from "./domovoi-mark"
import { annotationsForActiveSession } from "./annotations"
import { annotationCaptureUpload } from "./annotation-capture"
import {
  anchorResolutionsFor,
  createPreviewBridgeChannel,
  mergeAnchorResolutionBatch,
  previewReadyFor,
  previewResolveAnchorMessages,
  previewSelectionFor,
} from "./preview-bridge"
import { latestArtifactForActiveSession, previewControlLayoutFor, previewStageGridColumns, previewStageObservationKey, previewStagesForReview, previewToolbarLayoutFor, previewVariantsForActiveSession, reviewLayoutFor } from "./artifacts"
import { PreviewThumbnailLifecycle, previewThumbnailObjectUrl, previewThumbnailRect } from "./preview-thumbnails"
import {
  formatTokenCount,
  sessionUsageCostNote,
  sessionUsageFetchKey,
  sessionUsageReportedCost,
} from "./session-usage"
import { SkillBrowser } from "./skill-browser"
import { AuditLogView } from "./audit-log-view"
import { FleetView } from "./fleet-view"
import { ProviderSettings, type ProviderSecretStatus } from "./provider-settings"
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
import {
  providerHandoffDescription,
  preferredSessionProvider,
  providerCanStartSession,
  providerDisplayName,
  providerStatusLabel,
  reasoningOptionsFor,
  requiresProviderHandoff,
  selectRuntimeModel,
} from "./runtime"
import type { TerminalControls } from "./terminal-pane"
import {
  latestSessionHistoryRequest,
  historyWindowedAfterMerge,
  mergeOlderHistory,
  resetSessionHistoryWindow,
  SessionHistoryRequestController,
  sessionHistoryCategories,
  sessionHistoryEntryDetail,
  sessionHistoryEntryTitle,
} from "./session-history"
import { SessionEvidencePanel } from "./session-evidence"
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
import { WorkspaceNotificationTracker } from "./desktop-notifications"
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

const TerminalPane = lazy(async () => {
  const module = await import("./terminal-pane")
  return { default: module.TerminalPane }
})

export type WorkspaceShellProps = {
  clientKind?: ClientKind
  rpcUrl?: string
  rpcToken?: string
  windowBridge?: DesktopWindowBridge
  onChangeCredential?: () => void
}

export function ProjectSwitchConfirmationDialog({
  confirmation,
  pending = false,
  error = "",
  onCancel,
  onConfirm,
}: {
  confirmation: ProjectSwitchConfirmation
  pending?: boolean
  error?: string
  onCancel: () => void
  onConfirm: (path: string) => void
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop running work and switch projects?</AlertDialogTitle>
          <AlertDialogDescription>
            Domovoi keeps {confirmation.sessionCount} sessions and their saved history, including {confirmation.worktreeCount} isolated {confirmation.worktreeCount === 1 ? "worktree" : "worktrees"}, and restores them when you reopen this project. Switching now stops any turn, provider thread, and terminal that is still running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea className="max-h-44 rounded-md border">
          <ul className="divide-y">
            {confirmation.sessions.map((session) => (
              <li key={session.id} className="px-3 py-2 text-sm">
                <span className="block font-medium text-foreground">{session.title}</span>
                <span className="font-machine text-[10px] text-muted-foreground">{session.workspacePath ?? "No isolated worktree"}</span>
              </li>
            ))}
          </ul>
        </ScrollArea>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep current project</AlertDialogCancel>
          <Button
            disabled={pending}
            onClick={() => onConfirm(confirmation.requestedPath)}
          >
            {pending ? "Switching…" : "Stop work and switch"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function PreviewVariantThumbnail({ url }: { url?: string | undefined }) {
  const safeUrl = url?.startsWith("blob:") ? url : undefined
  return safeUrl
    ? <img className="aspect-video w-full rounded-sm border object-cover" src={safeUrl} alt="" />
    : <span aria-hidden="true" className="flex aspect-video w-full items-center justify-center rounded-sm border bg-muted font-machine text-[8px] text-faint">PREVIEW</span>
}

type ArtifactAuthorizationTarget = Pick<Artifact, "id" | "revision" | "sessionId">

export function artifactAuthorizationKey(targets: readonly ArtifactAuthorizationTarget[]): string {
  return JSON.stringify(targets.map(({ sessionId, id, revision }) => [sessionId, id, revision]))
}

function artifactAuthorizationTargets(key: string): ArtifactAuthorizationTarget[] {
  return (JSON.parse(key) as Array<[string, string, number]>).map(
    ([sessionId, id, revision]) => ({ sessionId, id, revision }),
  )
}

export async function capturePreviewThumbnailState({
  lifecycle,
  artifactId,
  revision,
  capture,
  sync,
}: {
  lifecycle: PreviewThumbnailLifecycle
  artifactId: string
  revision: number
  capture: () => Promise<Parameters<typeof previewThumbnailObjectUrl>[0]>
  sync: (ready: ReadonlyMap<string, string>) => void
}): Promise<void> {
  if (!lifecycle.reserve(artifactId, revision)) return
  sync(lifecycle.readyUrls())
  try {
    const url = previewThumbnailObjectUrl(await capture())
    if (!url) {
      lifecycle.fail(artifactId, revision)
      sync(lifecycle.readyUrls())
      return
    }
    lifecycle.resolve(artifactId, revision, url)
    sync(lifecycle.readyUrls())
  } catch {
    lifecycle.fail(artifactId, revision)
    sync(lifecycle.readyUrls())
  }
}

const statusClass: Record<SessionSummary["state"], string> = {
  active: "bg-success motion-safe:animate-pulse",
  waiting: "bg-warning",
  idle: "bg-faint",
  done: "bg-faint",
  failed: "bg-destructive",
  archiving: "bg-warning",
  archived: "bg-faint",
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

const defaultRuntime: Runtime = {
  provider: "codex",
  model: "default",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
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
  onOpenCommands,
  commandShortcut,
}: {
  snapshot: WorkspaceSnapshot | null
  connected: boolean
  emergencyStopPending: boolean
  emergencyStopOutcome: SystemEmergencyStopResult | null
  emergencyStopError: string | null
  bridge?: DesktopWindowBridge | undefined
  windowDecoration?: WorkspaceWindowDecoration | undefined
  onOpenProject: () => void
  onPauseAll: () => void
  onOpenCommands?: (() => void) | undefined
  commandShortcut?: string | undefined
}) {
  const ownsDecoration = Boolean(bridge) && windowDecoration === "domovoi"
  const emergencyStopMessage = emergencyStopError
    ? `Pause all failed: ${emergencyStopError}`
    : emergencyStopOutcome
      ? emergencyStopAnnouncement(emergencyStopOutcome)
      : null
  return (
    <header className="electron-drag flex h-11 shrink-0 items-center border-b bg-sidebar px-3">
      {ownsDecoration && bridge?.platform === "darwin" ? <div className="w-[64px]" aria-hidden="true" /> : null}
      <div className="electron-no-drag flex min-w-0 flex-1 items-center gap-2">
        <DomovoiMark reduced className="size-5 text-primary" />
        <span className="text-sm font-semibold tracking-[-0.025em]">Domovoi</span>
        <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
        <Button variant="ghost" size="sm" className="hidden sm:flex" disabled={!snapshot} onClick={onOpenProject}>
          {snapshot?.project?.name ?? "Open project"}
          {snapshot?.project ? (
            <span className="font-machine text-[10px] text-faint">{snapshot.project.branch}</span>
          ) : null}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
        <Badge variant="machine">
          <span aria-hidden="true" data-status-dot="" className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-destructive")} />
          <span className="sr-only">
            {connected ? "Connected to " : "Disconnected from "}{snapshot?.machine.name ?? "daemon"}.
          </span>
          <span className="hidden sm:inline">{snapshot?.machine.name ?? "daemon"}</span>
        </Badge>
      </div>
      <div className="electron-no-drag flex items-center gap-2">
        {onOpenCommands ? (
          <Button variant="ghost" size="sm" aria-label="Open command palette" onClick={onOpenCommands}>
            <SearchIcon data-icon="inline-start" />
            <span className="hidden md:inline">Commands</span>
            {commandShortcut ? <kbd className="hidden font-machine text-[9px] text-muted-foreground lg:inline">{commandShortcut}</kbd> : null}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Pause all"
          disabled={!connected || emergencyStopPending}
          onClick={onPauseAll}
        >
          <CircleStopIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Pause all</span>
        </Button>
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

export function SessionUsageSummary({ usage }: { usage: SessionUsage | null }) {
  if (!usage || (usage.totalTokens === 0 && usage.byRuntime.length === 0)) return null
  const cost = sessionUsageReportedCost(usage)
  const note = sessionUsageCostNote(usage)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="font-machine text-[10px] text-faint">
          {formatTokenCount(usage.totalTokens)} tokens
          <span aria-hidden="true">·</span>
          {cost ?? "cost unavailable"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[320px]">
        <DropdownMenuLabel>Session usage</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="flex flex-col gap-2 px-2 py-1.5 text-[11px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Input</span>
            <span className="font-machine">{formatTokenCount(usage.inputTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Cached input</span>
            <span className="font-machine">{formatTokenCount(usage.cachedInputTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Output</span>
            <span className="font-machine">{formatTokenCount(usage.outputTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Reasoning</span>
            <span className="font-machine">{formatTokenCount(usage.reasoningTokens)}</span>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>By provider and model</DropdownMenuLabel>
        <div className="flex flex-col gap-2 px-2 py-1.5 text-[11px]">
          {usage.byRuntime.length === 0 ? (
            <span className="text-muted-foreground">No recorded turns yet.</span>
          ) : usage.byRuntime.map((runtime) => (
            <div key={`${runtime.provider}/${runtime.model}`} className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{providerDisplayName(runtime.provider)}</span>
                <span className="truncate font-machine text-[9.5px] text-faint">{runtime.model}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end font-machine text-[9.5px]">
                <span>{formatTokenCount(runtime.totalTokens)} tokens</span>
                <span className="text-faint">{runtime.turns === 1 ? "1 turn" : `${runtime.turns} turns`}</span>
              </span>
            </div>
          ))}
        </div>
        {note ? <>
          <DropdownMenuSeparator />
          <p className="m-0 px-2 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">{note}</p>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  return `Pause all complete: ${summary.join(", ")}.`
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
        <span aria-hidden="true" data-status-dot="" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", statusClass[session.state])} />
        <span className="line-clamp-2 text-[12.5px] font-medium leading-[1.35]">{session.title}</span>
        <span className="sr-only">Status: {session.state}</span>
      </span>
      <span className="ml-3.5 flex flex-wrap items-center gap-1">
        <Badge variant="machine">{session.runtime.provider}/{session.runtime.model}</Badge>
        <Badge variant="outline" className="font-machine text-[9px] uppercase">
          {session.runtime.permissionMode}
        </Badge>
        {session.runtime.auto ? <Badge variant="warning">Auto</Badge> : null}
        {session.state === "waiting" ? (
          <span className="ml-auto text-[9px] uppercase tracking-wider text-warning">Approval</span>
        ) : null}
      </span>
    </button>
  )
}

function machineInitials(name: string): string {
  const words = name.split(/[^a-z0-9]+/i).filter((word) => word.length > 0)
  const first = words[0]?.[0] ?? name[0] ?? ""
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : (words[0]?.[1] ?? "")
  return `${first}${last}`.toUpperCase()
}

export function SessionsSidebar({
  snapshot,
  fleet,
  onCollapse,
  onActivate,
  onNewSession,
  onOpenProviderSettings,
  collapseButtonRef,
}: {
  snapshot: WorkspaceSnapshot
  fleet?: FleetMachine[] | null
  onCollapse: () => void
  onActivate: (sessionId: string) => void
  onNewSession: () => void
  onOpenProviderSettings: () => void
  collapseButtonRef?: RefObject<HTMLButtonElement | null>
}) {
  const groups = useMemo(
    () => [
      { label: "Active", states: ["active"] },
      { label: "Waiting", states: ["waiting"] },
      { label: "Idle", states: ["idle", "done", "failed"] },
      { label: "Archived", states: ["archiving", "archived"] },
    ],
    [],
  )

  return (
    <aside aria-label="Sessions" data-workspace-panel="sessions" className="flex h-full min-w-0 flex-col bg-sidebar">
      <div className="flex h-11 items-center justify-between px-3">
        <span className="text-[9px] uppercase tracking-[0.15em] text-faint">Sessions</span>
        <Button ref={collapseButtonRef} variant="ghost" size="icon-xs" aria-label="Collapse sessions" onClick={onCollapse}>
          <PanelLeftCloseIcon />
        </Button>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <Button variant="outline" className="w-full justify-start" onClick={onNewSession}>
          {snapshot.project ? "New session" : "Open project"}
        </Button>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-faint" />
          <Input aria-label="Search sessions, files, and skills" className="pl-8 font-machine text-[10px]" placeholder="Search sessions, files, skills" />
        </div>
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-2">
          {groups.map((group) => {
            const sessions = snapshot.sessions.filter((session) =>
              group.states.includes(session.state),
            )
            return (
              <section key={group.label} className="flex flex-col gap-1">
                <h2 className="m-0 flex h-7 items-center gap-2 px-2 text-[9px] font-normal uppercase tracking-[0.13em] text-faint">
                  <ChevronDownIcon className="size-3" />
                  {group.label}
                  <span className="font-machine">{sessions.length}</span>
                </h2>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === snapshot.activeSessionId}
                    onActivate={onActivate}
                  />
                ))}
              </section>
            )
          })}
        </div>
      </ScrollArea>
      <Separator />
      <div className="flex h-12 items-center gap-2 px-3">
        <span className="flex size-6 items-center justify-center rounded-full bg-accent text-[10px] font-medium">{machineInitials(snapshot.machine.name)}</span>
        <span className="min-w-0 flex-1"><span className="block text-[11px] font-medium">{snapshot.machine.name}</span><span className="block font-machine text-[9px] text-faint">{outcomeCount(fleet?.length ?? 1, "machine", "machines")} · {snapshot.machine.connection}</span></span>
        <LaptopIcon className="size-3.5 text-muted-foreground" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={providerSettingsNavigationLabel} onClick={onOpenProviderSettings}>
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{providerSettingsNavigationLabel}</TooltipContent>
        </Tooltip>
      </div>
    </aside>
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

  const facts = [
    ["Machine", approval.machine],
    ["Agent", approval.agent],
    ["Mode", approval.mode],
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
    <Alert ref={cardRef} variant="warning" className="mx-auto max-w-3xl gap-3 p-4">
      <CircleStopIcon />
      <AlertTitle className="flex items-center gap-2 text-[12.5px]">
        Approval required
        {approval.risk === "hard-gate" ? <Badge variant="warning">Hard gate</Badge> : null}
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
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={explainTriggerRef} variant="ghost" size="sm" onClick={() => setExplainOpen(true)}>Deny and explain</Button>
          <Button variant="ghost" size="sm" onClick={() => onResolve("deny")}>Deny</Button>
          <Button variant="outline" size="sm" onClick={() => onResolve("always-project")}>Always in this project</Button>
          <Button variant="warning" size="sm" onClick={() => onResolve("allow-once")}>Allow once</Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

type LauncherMode = "project" | "session" | null

export function ProviderReadinessList({
  providers,
}: {
  providers: readonly ProviderRuntime[]
}) {
  if (providers.length === 0) {
    return <FieldDescription>Provider readiness has not been reported by this machine yet.</FieldDescription>
  }

  return (
    <div role="list" aria-label="Provider readiness" className="divide-y rounded-lg border bg-background/40">
      {providers.map((provider) => {
        const status = providerStatusLabel(provider)
        const variant = provider.status === "ready"
          ? "success"
          : provider.status === "auth-required"
            ? "warning"
            : "outline"
        return (
          <div key={provider.id} role="listitem" className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-foreground">{providerDisplayName(provider.id)}</span>
              <span className="truncate font-machine text-[9px] text-faint">
                {provider.command}{provider.version ? ` · ${provider.version}` : ""}
                {!provider.sessionCapable && provider.status !== "missing" ? " · adapter unavailable" : ""}
              </span>
            </span>
            <Badge variant={variant}>{status}</Badge>
          </div>
        )
      })}
    </div>
  )
}

export function LauncherDialog({
  mode,
  providers,
  defaultProviderId,
  defaultPermissionMode,
  onOpenChange,
  onOpenProject,
  onCreateSession,
  onListModels,
}: {
  mode: LauncherMode
  providers: readonly ProviderRuntime[]
  defaultProviderId?: string
  defaultPermissionMode: PermissionMode
  onOpenChange: (open: boolean) => void
  onOpenProject: (path: string) => Promise<void>
  onCreateSession: (title: string, runtime: Runtime) => Promise<void>
  onListModels: (provider: string) => Promise<ProviderModel[]>
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [runtime, setRuntime] = useState(() => ({
    ...defaultRuntime,
    ...(defaultProviderId ? { provider: defaultProviderId } : {}),
    permissionMode: defaultPermissionMode,
  }))
  const [models, setModels] = useState<ProviderModel[]>([])
  const [modelsPending, setModelsPending] = useState(false)
  const [modelsError, setModelsError] = useState("")
  const modelRequest = useRef(0)
  // The effect below reads the latest providers without depending on the
  // identity of the array they arrive in.
  const providersRef = useRef(providers)
  providersRef.current = providers
  const providerReadinessKey = providers
    .map((provider) => `${provider.id}:${provider.status}:${provider.version ?? ""}:${provider.sessionCapable}`)
    .join("|")

  useEffect(() => {
    if (mode) {
      setValue("")
      setError("")
    }
    if (mode !== "session") {
      modelRequest.current += 1
      return
    }

    const provider = providersRef.current.find((candidate) =>
      candidate.id === defaultProviderId && providerCanStartSession(candidate)
    ) ?? preferredSessionProvider(providersRef.current)
    if (!provider) {
      setModels([])
      setModelsError("No provider on this machine can start a session")
      return
    }

    const request = ++modelRequest.current
    setRuntime({
      ...defaultRuntime,
      provider: provider.id,
      permissionMode: defaultPermissionMode,
    })
    setModels([])
    setModelsPending(true)
    setModelsError("")
    void onListModels(provider.id).then(
      (nextModels) => {
        if (request !== modelRequest.current) return
        setModels(nextModels)
        const selected = nextModels.find((model) => model.isDefault) ?? nextModels[0]
        if (selected) setRuntime((current) => selectRuntimeModel(current, selected))
        else setModelsError(`${providerDisplayName(provider.id)} did not report any models`)
      },
      (cause: unknown) => {
        if (request === modelRequest.current) {
          setModelsError(cause instanceof Error ? cause.message : "Models could not be loaded")
        }
      },
    ).finally(() => {
      if (request === modelRequest.current) setModelsPending(false)
    })
    // Keyed on what the providers say, not on the array a new snapshot happens
    // to allocate: an equal list must not reset the model already chosen.
  }, [defaultPermissionMode, defaultProviderId, mode, onListModels, providerReadinessKey])

  const selectProvider = (provider: ProviderRuntime) => {
    if (!providerCanStartSession(provider)) return
    const request = ++modelRequest.current
    setRuntime((current) => ({ ...current, provider: provider.id, model: "default" }))
    setModels([])
    setModelsPending(true)
    setModelsError("")
    void onListModels(provider.id).then(
      (nextModels) => {
        if (request !== modelRequest.current) return
        setModels(nextModels)
        const selected = nextModels.find((model) => model.isDefault) ?? nextModels[0]
        if (selected) setRuntime((current) => selectRuntimeModel(current, selected))
        else setModelsError(`${providerDisplayName(provider.id)} did not report any models`)
      },
      (cause: unknown) => {
        if (request === modelRequest.current) {
          setModelsError(cause instanceof Error ? cause.message : "Models could not be loaded")
        }
      },
    ).finally(() => {
      if (request === modelRequest.current) setModelsPending(false)
    })
  }

  const isProject = mode === "project"
  const selectedProvider = providers.find((provider) => provider.id === runtime.provider)
  const selectedModel = models.find((model) =>
    model.provider === runtime.provider && model.id === runtime.model,
  )
  const runtimeReady = Boolean(selectedProvider && providerCanStartSession(selectedProvider) && selectedModel)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    if (!input || !mode || pending) return
    setPending(true)
    setError("")
    try {
      if (isProject) await onOpenProject(input)
      else await onCreateSession(input, runtime)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Domovoi could not complete the request")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open && pending) return
        onOpenChange(open)
      }}
    >
      <DialogContent className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", !isProject && "sm:max-w-lg")}>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{isProject ? "Open a project" : "Start a session"}</DialogTitle>
            <DialogDescription>
              {isProject
                ? "Choose a local Git repository. Code stays on this machine."
                : "Domovoi creates an isolated worktree before the first agent turn."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="launcher-value">
                {isProject ? "Repository path" : "Session goal"}
              </FieldLabel>
              <Input
                id="launcher-value"
                autoFocus
                aria-invalid={Boolean(error)}
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={isProject ? "/home/you/projects/example" : "Describe what this session should accomplish"}
              />
              <FieldDescription>
                {isProject ? "The daemon validates the repository before opening it." : "Runtime and permission controls remain editable in the session."}
              </FieldDescription>
              <FieldError>{error}</FieldError>
            </Field>
            {!isProject ? (
              <Field>
                <FieldLabel>Provider and model</FieldLabel>
                <div className="grid gap-2 sm:grid-cols-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="justify-between"
                        aria-label="Execution provider"
                        disabled={pending}
                      >
                        <span className="truncate">
                          {selectedProvider ? providerDisplayName(selectedProvider.id) : "No provider available"}
                        </span>
                        <ChevronDownIcon data-icon="inline-end" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-72">
                      <DropdownMenuLabel>Execution provider</DropdownMenuLabel>
                      <DropdownMenuGroup>
                        {providers.map((provider) => (
                          <DropdownMenuItem
                            key={provider.id}
                            disabled={pending || !providerCanStartSession(provider)}
                            onSelect={() => selectProvider(provider)}
                          >
                            {provider.id === runtime.provider ? <CheckIcon /> : null}
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span>{providerDisplayName(provider.id)}</span>
                              <span className="truncate font-machine text-[9px] text-faint">
                                {providerStatusLabel(provider)}{provider.version ? ` · ${provider.version}` : ""}
                                {!provider.sessionCapable && provider.status !== "missing" ? " · adapter unavailable" : ""}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="justify-between"
                        aria-label="Model"
                        aria-describedby={modelsError ? "launcher-model-error" : undefined}
                        aria-invalid={Boolean(modelsError)}
                        disabled={pending || modelsPending || models.length === 0}
                      >
                        <span className="truncate">{modelsPending ? "Loading models" : selectedModel?.displayName ?? "Select model"}</span>
                        <ChevronDownIcon data-icon="inline-end" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72">
                      <DropdownMenuLabel>{providerDisplayName(runtime.provider)} models</DropdownMenuLabel>
                      <DropdownMenuGroup>
                        {models.map((model) => (
                          <DropdownMenuItem key={model.id} onSelect={() => setRuntime((current) => selectRuntimeModel(current, model))}>
                            {model.id === runtime.model ? <CheckIcon /> : null}
                            <span className="flex min-w-0 flex-col">
                              <span>{model.displayName}</span>
                              <span className="truncate font-machine text-[9px] text-faint">{model.id}</span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <FieldError id="launcher-model-error">{modelsError}</FieldError>
                <ProviderReadinessList providers={providers} />
              </Field>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!value.trim() || pending || (!isProject && !runtimeReady)}>
              {isProject ? <FolderOpenIcon data-icon="inline-start" /> : <BotIcon data-icon="inline-start" />}
              {pending ? "Working" : isProject ? "Open project" : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
    <div className="flex items-center gap-1 self-center rounded-full border bg-card py-1 pr-1 pl-3 font-machine text-[9px] text-faint">
      <span>Checkpoint · {item.label}</span>
      {item.commit ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={disabled} className="h-6 rounded-full px-2 text-[9px]">
              Restore worktree
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restore this checkpoint?</AlertDialogTitle>
              <AlertDialogDescription>
                Domovoi checkpoints the current worktree first, then restores {item.label}. The
                current state remains available as a recovery checkpoint.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <CheckpointRestoreAction
                checkpointId={item.id}
                disabled={disabled}
                onRestore={onRestore}
              />
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}

export function CheckpointRestoreAction({
  checkpointId,
  disabled,
  onRestore,
}: {
  checkpointId: string
  disabled: boolean
  onRestore: (checkpointId: string) => void
}) {
  return (
    <AlertDialogAction
      disabled={disabled}
      onClick={() => {
        if (!disabled) onRestore(checkpointId)
      }}
    >
      Restore worktree
    </AlertDialogAction>
  )
}

export function checkpointRestoreBlocked(pending: boolean, archiveReadOnly: boolean): boolean {
  return pending || archiveReadOnly
}

export function checkpointBlockedReason(activeTurnId: string | undefined): string | undefined {
  return activeTurnId ? "Stop the active turn before creating a checkpoint" : undefined
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

export function Thread({
  snapshot,
  connected,
  emergencyStopPending = false,
  fleet,
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
  onPauseSession,
  onArchiveSession,
  onOpenExternal,
  onPairMachine,
  onSelectMachine,
  onTransferSession,
  externalEditor = "system",
  usage = null,
}: {
  snapshot: WorkspaceSnapshot
  connected: boolean
  emergencyStopPending?: boolean | undefined
  fleet?: FleetMachine[] | undefined
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
  onSend: (sessionId: string, prompt: string) => Promise<void>
  onCheckpoint: (sessionId: string) => Promise<void>
  onRestoreCheckpoint: (sessionId: string, checkpointId: string) => Promise<void>
  onPauseSession: (sessionId: string) => Promise<void>
  onArchiveSession: (sessionId: string) => Promise<void>
  onOpenExternal?: ((path: string) => Promise<void>) | undefined
  onPairMachine?: ((request: PairMachineRequest) => Promise<PairedMachine>) | undefined
  onSelectMachine?: ((machineId: string) => void) | undefined
  onTransferSession?: ((
    params: Omit<SessionTransferParams, "client">,
  ) => Promise<SessionTransferResult>) | undefined
  externalEditor?: DesktopExternalEditor | undefined
  usage?: SessionUsage | null | undefined
}) {
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)
  const approval = active
    ? snapshot.approvals.find((candidate) => candidate.sessionId === active.id)
    : undefined
  const [prompt, setPrompt] = useState("")
  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  const [pairingMachine, setPairingMachine] = useState(false)
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null)
  const [transferReceipt, setTransferReceipt] = useState<SessionTransferReceipt | null>(null)
  const [pending, setPending] = useState(false)
  const [runtimePending, setRuntimePending] = useState(false)
  const [sendError, setSendError] = useState("")
  const [runtimeError, setRuntimeError] = useState("")
  const [restartPending, setRestartPending] = useState(false)
  const [desktopError, setDesktopError] = useState("")

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

  const machines = fleet ?? [localMachineEntry(snapshot)]
  const sourceMachine = machines.find(
    (machine) => machine.id === (currentMachineId ?? snapshot.machine.id),
  ) ?? localMachineEntry(snapshot)
  const transferTarget = transferTargetId
    ? machines.find((machine) => machine.id === transferTargetId)
    : undefined

  const checkpointReason = checkpointBlockedReason(active.activeTurnId)
  const archiveReadOnly = sessionIsArchiveReadOnly(active)
  const providerRestartRequired = active.state === "failed" && !active.providerThreadId
  const forkCheckpoint = snapshot.thread.filter((item) =>
    item.sessionId === active.id && item.kind === "checkpoint" && item.commit
  ).at(-1)
  const forkReason = forkSessionBlockedReason(active, forkCheckpoint)

  const submitPrompt = async () => {
    const nextPrompt = prompt.trim()
    if (!nextPrompt || pending || providerRestartRequired || emergencyStopPending) return
    setPending(true)
    setSendError("")
    try {
      await onSend(active.id, nextPrompt)
      setPrompt("")
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The message could not be sent")
    } finally {
      setPending(false)
    }
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
    try {
      await onPauseSession(active.id)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The session could not be paused")
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
            <SessionUsageSummary usage={usage} />
          </div>
        </div>
        {archiveReadOnly ? <Badge variant="outline">{active.state === "archived" ? "Archived" : "Archiving"}</Badge> : (
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
            <RuntimeControls
              runtime={active.runtime}
              providers={snapshot.machine.providers}
              pending={runtimePending}
              {...(forkCheckpoint ? { forkCheckpointId: forkCheckpoint.id } : {})}
              {...(forkReason ? { forkBlockedReason: forkReason } : {})}
              onChange={(runtime) => void updateRuntime(runtime)}
              onFork={forkRuntime}
              onListModels={onListModels}
            />
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
          {renderedThreadForActiveSession(snapshot).map((item) => {
            if (item.kind === "checkpoint") {
              return <CheckpointThreadItem key={item.id} item={item} disabled={pending || archiveReadOnly || Boolean(active.activeTurnId)} onRestore={(checkpointId) => void restoreCheckpoint(checkpointId)} />
            }
            if (item.kind === "user") {
              return <div key={item.id} className="max-w-[82%] self-end rounded-xl border bg-card px-4 py-3"><MarkdownQuickView source={item.body} /></div>
            }
            if (item.kind === "system") {
              return <Alert key={item.id} className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"><BotIcon /><AlertTitle>System</AlertTitle><AlertDescription><MarkdownQuickView source={[item.body, item.detail].filter(Boolean).join("\n\n")} /></AlertDescription></Alert>
            }
            if (item.kind === "receipt") {
              return <Alert key={item.id} className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"><CheckIcon /><AlertTitle>{item.operation}: {item.decision}</AlertTitle><AlertDescription>Checkpoint {item.checkpoint} · decided from {item.client}{item.connectionId ? ` · connection ${item.connectionId}` : item.clientId ? ` · declared client ${item.clientId}` : ""}{item.explanation ? ` · ${item.explanation}` : ""}</AlertDescription></Alert>
            }
            if (item.kind === "tool") {
              return <Alert key={item.id}><TerminalSquareIcon /><AlertTitle>{item.title}</AlertTitle><AlertDescription><Badge variant="outline">{item.status}</Badge>{item.output ? <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-machine text-[10px]">{item.output}</pre> : null}</AlertDescription></Alert>
            }
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
          <Alert className="mx-auto max-w-[620px]">
            <ArchiveIcon />
            <AlertTitle>{active.state === "archived" ? "Archived" : "Archiving session"}</AlertTitle>
            <AlertDescription>
              {active.state === "archived"
                ? "This session is read-only. Its history, checkpoints, artifacts, and annotations remain available."
                : "Cleanup will resume safely if the daemon restarts."}
            </AlertDescription>
          </Alert>
        </div>
      ) : <div className="px-5 py-3 [mask-image:linear-gradient(to_bottom,transparent_0,black_12px)]">
        {desktopError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[620px]"><CircleStopIcon /><AlertTitle>Desktop action failed</AlertTitle><AlertDescription>{desktopError}</AlertDescription></Alert> : null}
        {runtimeError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[620px]"><CircleStopIcon /><AlertTitle>Runtime update failed</AlertTitle><AlertDescription>{runtimeError}</AlertDescription></Alert> : null}
        {sendError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[620px]"><CircleStopIcon /><AlertTitle>Agent request failed</AlertTitle><AlertDescription>{sendError}</AlertDescription></Alert> : null}
        <div className="mx-auto flex max-w-[620px] flex-col gap-2 rounded-xl border bg-card p-3">
          <Textarea
            aria-label="Message"
            rows={2}
            className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            placeholder="Message the agent"
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
              <MachineSwitcher
                machines={machines}
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
              {checkpointReason ? <span role="status" className="font-machine text-[9px] text-faint">{checkpointReason}</span> : null}
              {active.activeTurnId ? <Button variant="ghost" size="sm" disabled={pending || !connected} onClick={() => void pauseSession()}><CircleStopIcon data-icon="inline-start" />Stop</Button> : null}
              <ArchiveSessionAction disabled={pending || !connected} onArchive={() => void archiveSession()} />
            </div>
            <div className="ml-auto flex items-center gap-2"><span role="status" className="font-machine text-[9px] text-faint">{providerRestartRequired ? "Restart the provider before sending" : "Ctrl/⌘ + Enter send"}</span><Button variant="ghost" size="icon-sm" aria-label="Expand prompt editor" onClick={() => setPromptEditorOpen(true)}><Maximize2Icon /></Button><Button size="icon-sm" aria-label="Send message" disabled={!prompt.trim() || pending || providerRestartRequired || emergencyStopPending} onClick={() => void submitPrompt()}><SendIcon /></Button></div>
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

// The handoff's machine menu reports active sessions, so sessions that are
// idle, finished, or archived are not counted as work on this machine.
export function activeSessionCount(snapshot: WorkspaceSnapshot): number {
  return snapshot.sessions.filter((session) => session.state === "active" || session.state === "waiting").length
}

// The fleet is fetched separately, so the composer still names this machine
// from the snapshot until that answer arrives.
function localMachineEntry(snapshot: WorkspaceSnapshot): FleetMachine {
  return {
    id: snapshot.machine.id,
    label: snapshot.machine.name,
    platform: snapshot.machine.platform,
    arch: snapshot.machine.arch,
    version: snapshot.machine.version,
    connection: "local",
    capabilities: [],
    protocolVersion,
    transports: [],
    heartbeat: { state: "online", lastSeenAt: new Date(0).toISOString() },
    health: "healthy",
    self: true,
  }
}

export function activeThreadKey(snapshot: WorkspaceSnapshot): string {
  return snapshot.activeSessionId ?? "no-active-session"
}

export function renderedThreadForActiveSession(snapshot: WorkspaceSnapshot): ThreadItem[] {
  if (!snapshot.activeSessionId) return []
  return boundedClientThread(snapshot.thread, snapshot.activeSessionId)
    .filter((item) => item.sessionId === snapshot.activeSessionId)
}

export function sessionIsArchiveReadOnly(
  session: WorkspaceSnapshot["sessions"][number] | undefined,
): boolean {
  return session?.state === "archiving" || session?.state === "archived"
}

export function forkSessionBlockedReason(
  session: SessionSummary,
  checkpoint: ThreadItem | undefined,
): string | undefined {
  if (session.state === "archiving" || session.state === "archived") {
    return "Archived sessions cannot be forked"
  }
  if (session.activeTurnId || session.state === "active") {
    return "Stop the active turn before forking"
  }
  if (session.state === "waiting") return "Resolve the pending approval before forking"
  if (!session.workspacePath) return "This session has no isolated worktree to fork"
  if (checkpoint?.kind !== "checkpoint" || !checkpoint.commit) {
    return "Create a durable checkpoint before forking"
  }
  return undefined
}

export function providerHandoffChoices(pending: boolean, forkBlockedReason: string | undefined) {
  return [
    { label: "Switch here", variant: "outline" as const, disabled: pending },
    {
      label: "Fork session",
      variant: "default" as const,
      disabled: pending || Boolean(forkBlockedReason),
    },
  ] as const
}

export type ProviderChoice = {
  model: ProviderModel
  requestId: string
}

export function openProviderChoice(
  runtime: Runtime,
  model: ProviderModel,
  createRequestId: () => string = () => crypto.randomUUID(),
): ProviderChoice | undefined {
  if (runtime.provider === model.provider && runtime.model === model.id) return undefined
  return { model, requestId: createRequestId() }
}

export function forkProviderChoice(
  runtime: Runtime,
  choice: ProviderChoice,
  checkpointId: string,
  onFork: (runtime: Runtime, checkpointId: string, requestId: string) => Promise<void>,
): Promise<void> {
  return onFork(selectRuntimeModel(runtime, choice.model), checkpointId, choice.requestId)
}

export function normalizePermissionMode(runtime: Runtime, permissionMode: PermissionMode): Runtime {
  return {
    ...runtime,
    permissionMode,
    auto: permissionMode === "build" && runtime.auto,
  }
}

export function RuntimeControls({
  runtime,
  providers,
  pending,
  forkCheckpointId,
  forkBlockedReason,
  onChange,
  onFork,
  onListModels,
}: {
  runtime: Runtime
  providers: readonly ProviderRuntime[]
  pending: boolean
  forkCheckpointId?: string
  forkBlockedReason?: string
  onChange: (runtime: Runtime) => void
  onFork: (runtime: Runtime, checkpointId: string, requestId: string) => Promise<void>
  onListModels: (provider: string) => Promise<ProviderModel[]>
}) {
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ProviderModel[]>>({})
  const [modelsPending, setModelsPending] = useState<Record<string, boolean>>({})
  const [modelsError, setModelsError] = useState<Record<string, string>>({})
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>()
  const [choicePending, setChoicePending] = useState(false)
  const handoffModel = providerChoice?.model
  const models = modelCatalogs[runtime.provider] ?? []
  const selectedModel = models.find(
    (model) => model.provider === runtime.provider && model.id === runtime.model,
  )
  const reasoningOptions = reasoningOptionsFor(selectedModel)
  const reasoningUnavailable = selectedModel === undefined || reasoningOptions.length === 0
  const availableProviders = providers.filter(providerCanStartSession)
  const actionPending = pending || choicePending
  const handoffChoices = providerHandoffChoices(actionPending, forkBlockedReason)

  const loadModels = (provider: string) => {
    if (modelCatalogs[provider] || modelsPending[provider]) return
    setModelsPending((current) => ({ ...current, [provider]: true }))
    setModelsError((current) => ({ ...current, [provider]: "" }))
    void onListModels(provider).then(
      (nextModels) => setModelCatalogs((current) => ({ ...current, [provider]: nextModels })),
      (cause: unknown) => {
        setModelsError((current) => ({
          ...current,
          [provider]: cause instanceof Error ? cause.message : "Models could not be loaded",
        }))
      },
    ).finally(() => setModelsPending((current) => ({ ...current, [provider]: false })))
  }

  useEffect(() => {
    let active = true
    setModelsPending((current) => ({ ...current, [runtime.provider]: true }))
    setModelsError((current) => ({ ...current, [runtime.provider]: "" }))
    void onListModels(runtime.provider).then(
      (nextModels) => {
        if (active) setModelCatalogs((current) => ({ ...current, [runtime.provider]: nextModels }))
      },
      (cause: unknown) => {
        if (active) {
          setModelsError((current) => ({
            ...current,
            [runtime.provider]: cause instanceof Error ? cause.message : "Models could not be loaded",
          }))
        }
      },
    ).finally(() => {
      if (active) setModelsPending((current) => ({ ...current, [runtime.provider]: false }))
    })
    return () => { active = false }
  }, [onListModels, runtime.provider])

  const chooseModel = (model: ProviderModel) => {
    setProviderChoice(openProviderChoice(runtime, model))
  }

  const submitForkChoice = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (!providerChoice || !forkCheckpointId || forkBlockedReason || actionPending) return
    setChoicePending(true)
    try {
      await forkProviderChoice(runtime, providerChoice, forkCheckpointId, onFork)
      setProviderChoice(undefined)
    } catch {
      // The parent surfaces the RPC error. Keep this attempt and request ID open for retry.
    } finally {
      setChoicePending(false)
    }
  }

  const setMode = (permissionMode: string) => {
    if (permissionMode) onChange(normalizePermissionMode(runtime, permissionMode as PermissionMode))
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}><BotIcon data-icon="inline-start" />{runtime.provider} / {runtime.model}<ChevronDownIcon data-icon="inline-end" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Provider and model</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {availableProviders.map((provider) => {
            const providerModels = modelCatalogs[provider.id] ?? []
            return (
              <DropdownMenuSub
                key={provider.id}
                onOpenChange={(open) => { if (open) loadModels(provider.id) }}
              >
                <DropdownMenuSubTrigger disabled={pending}>
                  {provider.id === runtime.provider ? <CheckIcon /> : <BotIcon />}
                  {providerDisplayName(provider.id)}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-80 overflow-y-auto">
                  <DropdownMenuLabel>{providerDisplayName(provider.id)} models</DropdownMenuLabel>
                  <DropdownMenuGroup>
                    {modelsPending[provider.id] ? <DropdownMenuItem disabled>Loading installed models</DropdownMenuItem> : null}
                    {modelsError[provider.id] ? <DropdownMenuItem disabled className="whitespace-normal text-destructive">{modelsError[provider.id]}</DropdownMenuItem> : null}
                    {!modelsPending[provider.id] && !modelsError[provider.id] && providerModels.length === 0
                      ? <DropdownMenuItem disabled>No models reported</DropdownMenuItem>
                      : null}
                    {providerModels.map((model) => (
                      <DropdownMenuItem
                        key={`${model.provider}:${model.id}`}
                        disabled={pending}
                        onSelect={() => chooseModel(model)}
                      >
                        {model.id === runtime.model && model.provider === runtime.provider ? <CheckIcon /> : null}
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{model.displayName}</span>
                          <span className="truncate font-machine text-[9px] text-faint">{model.id}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })}
          {availableProviders.length === 0 ? <DropdownMenuItem disabled>No session providers are ready</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={pending || reasoningUnavailable}>Think: {runtime.reasoning}<ChevronDownIcon data-icon="inline-end" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>{reasoningOptions.map((reasoning) => <DropdownMenuItem key={reasoning} disabled={pending} onSelect={() => onChange({ ...runtime, reasoning })}>{reasoning === runtime.reasoning ? <CheckIcon /> : null}{reasoning}</DropdownMenuItem>)}</DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToggleGroup type="single" value={runtime.permissionMode} disabled={pending} onValueChange={setMode} variant="outline" size="sm" spacing={0} aria-label="Permission mode">
        <ToggleGroupItem value="ask">Ask</ToggleGroupItem><ToggleGroupItem value="plan">Plan</ToggleGroupItem><ToggleGroupItem value="build">Build</ToggleGroupItem>
      </ToggleGroup>
      <label className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] text-muted-foreground"><Switch size="sm" checked={runtime.auto} disabled={pending || runtime.permissionMode !== "build"} onCheckedChange={(auto) => onChange({ ...runtime, auto: runtime.permissionMode === "build" && auto })} />Auto</label>
      <AlertDialog
        open={providerChoice !== undefined}
        onOpenChange={(open) => {
          if (!open && !actionPending) setProviderChoice(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch here or fork session?</AlertDialogTitle>
            <AlertDialogDescription>
              {handoffModel
                ? requiresProviderHandoff(runtime, handoffModel)
                  ? providerHandoffDescription(
                      providerDisplayName(handoffModel.provider),
                      handoffModel.displayName,
                    )
                  : `Switch here changes this session to ${handoffModel.displayName}.`
                : null}
              {handoffModel
                ? ` Fork session starts ${providerDisplayName(handoffModel.provider)} / ${handoffModel.displayName} in a separate worktree from the latest durable checkpoint. Domovoi records the source, checkpoint, provider/model, and requesting client in its history.`
                : null}
              {forkBlockedReason ? ` Fork unavailable: ${forkBlockedReason}.` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={handoffChoices[0].variant}
              disabled={handoffChoices[0].disabled}
              onClick={() => {
                if (handoffModel) onChange(selectRuntimeModel(runtime, handoffModel))
              }}
            >
              {handoffChoices[0].label}
            </AlertDialogAction>
            <AlertDialogAction
              variant={handoffChoices[1].variant}
              disabled={handoffChoices[1].disabled}
              title={forkBlockedReason}
              onClick={(event) => void submitForkChoice(event)}
            >
              {handoffChoices[1].label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function HistoryPanel({
  sessionId,
  connected,
  onLoad,
}: {
  sessionId: string | null
  connected: boolean
  onLoad: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<SessionHistoryPage>
}) {
  const [categories, setCategories] = useState<SessionHistoryCategory[]>(() =>
    sessionHistoryCategories.map(({ value }) => value)
  )
  const [query, setQuery] = useState("")
  const [page, setPage] = useState<SessionHistoryPage>()
  const [historyWindowed, setHistoryWindowed] = useState(false)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const requestControllerRef = useRef<SessionHistoryRequestController<SessionHistoryPage> | null>(null)
  if (!requestControllerRef.current) {
    requestControllerRef.current = new SessionHistoryRequestController<SessionHistoryPage>()
  }
  const previousSearchRef = useRef<{ context: string; query: string } | null>(null)
  // The effect below runs on what the filters say, not on the identity of the
  // arrays and strings they arrive in, so it reads the latest through a ref.
  const filtersRef = useRef({ categories, query })
  filtersRef.current = { categories, query }
  const filterKey = `${categories.join(",")}:${query.trim()}`

  useEffect(() => {
    setPage(undefined)
    setHistoryWindowed(false)
    setError("")
    if (!sessionId || !connected) {
      requestControllerRef.current!.cancel()
      setLoading(false)
      return
    }
    const { categories: activeCategories, query: activeQuery } = filtersRef.current
    const context = `${sessionId}:${activeCategories.join(",")}`
    const trimmedQuery = activeQuery.trim()
    const previous = previousSearchRef.current
    const debounce = previous?.context === context && previous.query !== trimmedQuery
    previousSearchRef.current = { context, query: trimmedQuery }
    setLoading(true)
    requestControllerRef.current!.schedule({
      debounce,
      load: (signal) => onLoad(
        sessionId,
        latestSessionHistoryRequest(activeCategories, trimmedQuery),
        { signal },
      ),
      onSuccess: setPage,
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : "Session history could not be loaded")
      },
      onSettled: () => setLoading(false),
    })
  }, [connected, filterKey, historyRefresh, onLoad, sessionId])

  useEffect(() => () => requestControllerRef.current?.dispose(), [])

  const toggleCategory = (category: SessionHistoryCategory) => {
    if (categories.includes(category) && categories.length === 1) return
    setPage(undefined)
    setCategories((current) => current.includes(category)
      ? current.length === 1 ? current : current.filter((value) => value !== category)
      : sessionHistoryCategories.map(({ value }) => value).filter(
        (value) => value === category || current.includes(value),
      ))
  }

  const loadOlder = () => {
    if (!sessionId || !page?.hasMore || !page.nextCursor || loading) return
    setLoading(true)
    setError("")
    requestControllerRef.current!.schedule({
      debounce: false,
      load: (signal) => onLoad(
        sessionId,
        {
          categories,
          ...(query.trim() ? { query: query.trim() } : {}),
          before: page.nextCursor,
          limit: 50,
        },
        { signal },
      ),
      onSuccess: (older) => {
        setHistoryWindowed((current) => historyWindowedAfterMerge(current, page, older))
        setPage(mergeOlderHistory(page, older))
      },
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : "Older history could not be loaded")
      },
      onSettled: () => setLoading(false),
    })
  }

  const backToLatest = () => {
    const reset = resetSessionHistoryWindow({ page, historyWindowed, historyRefresh })
    setPage(reset.page)
    setHistoryWindowed(reset.historyWindowed)
    setHistoryRefresh(reset.historyRefresh)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-faint" />
          <Input
            aria-label="Search session history"
            className="pl-8 font-machine text-[10px]"
            placeholder="Search recorded history"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {sessionHistoryCategories.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={categories.includes(value) ? "secondary" : "ghost"}
              aria-pressed={categories.includes(value)}
              onClick={() => toggleCategory(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-3">
          {page?.items.map((entry) => {
            const detail = sessionHistoryEntryDetail(entry)
            return (
              <div key={entry.id} className="flex gap-3 border-b py-3 last:border-b-0">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 break-words text-[12px] font-medium">{sessionHistoryEntryTitle(entry)}</span>
                    <span className="font-machine text-[9px] text-faint">{entry.createdAt.slice(11, 16)}</span>
                  </div>
                  <Badge variant="outline" className="mt-1 font-machine text-[8px]">{entry.category}</Badge>
                  {detail ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-machine text-[10px] leading-relaxed text-muted-foreground">{detail}</pre> : null}
                </div>
              </div>
            )
          })}
          {!loading && !error && page?.items.length === 0 ? (
            <Empty className="min-h-48 border-0"><EmptyHeader><EmptyMedia variant="icon"><HistoryIcon /></EmptyMedia><EmptyTitle>No matching history</EmptyTitle><EmptyDescription>Change filters or search terms.</EmptyDescription></EmptyHeader></Empty>
          ) : null}
          {error ? <Alert variant="destructive" className="my-3"><CircleStopIcon /><AlertTitle>History unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
          {historyWindowed ? <Button className="my-3 self-center" variant="ghost" size="sm" disabled={loading} onClick={backToLatest}>Back to latest</Button> : null}
          {page?.hasMore ? <Button className="my-3 self-center" variant="outline" size="sm" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading" : "Load older"}</Button> : null}
          {loading && !page ? <p role="status" className="p-4 text-center font-machine text-[10px] text-faint">Loading history</p> : null}
        </div>
      </ScrollArea>
    </div>
  )
}

export function ArtifactDock({
  snapshot,
  onCollapse,
  collapseButtonRef,
  defaultTab,
  rpcUrl,
  authorizeArtifact,
  connected,
  terminalControls,
  onReplyToAnnotation,
  onSetAnnotationStatus,
  onCreateAnnotation,
  onLoadSessionHistory,
  onLoadSessionEvidence,
  onRevertSessionFile,
  captureAnnotation,
}: {
  snapshot: WorkspaceSnapshot
  onCollapse: () => void
  collapseButtonRef?: RefObject<HTMLButtonElement | null>
  defaultTab: "changes" | "preview"
  rpcUrl: string
  authorizeArtifact: (input: {
    sessionId: string
    artifactId: string
    revision: number
    purpose: ArtifactAccess["purpose"]
    bridgeChannel?: string
    parentOrigin?: string
  }) => Promise<ArtifactAccess>
  connected: boolean
  terminalControls: TerminalControls
  onReplyToAnnotation: (annotationId: string, body: string) => Promise<void>
  onSetAnnotationStatus: (annotationId: string, status: Annotation["status"]) => Promise<void>
  onCreateAnnotation: (input: {
    sessionId: string
    artifactId: string
    anchor: Annotation["anchor"]
    body: string
    variantId?: string
    visualContextUpload?: {
      artifactRevision: number
      mimeType: "image/png"
      width: number
      height: number
      data: string
    }
  }) => Promise<void>
  captureAnnotation?: DesktopWindowBridge["captureAnnotation"]
  onLoadSessionHistory: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<SessionHistoryPage>
  onLoadSessionEvidence: (sessionId: string) => Promise<SessionEvidence>
  onRevertSessionFile: (sessionId: string, path: string) => Promise<void>
}) {
  const plan = latestArtifactForActiveSession(snapshot, "plan")
  const previewCandidate = latestArtifactForActiveSession(snapshot, "preview")
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | undefined>(previewCandidate?.id)
  const previewVariants = useMemo(
    () => previewVariantsForActiveSession(snapshot, selectedPreviewId),
    [selectedPreviewId, snapshot],
  )
  const preview = previewVariants.find((artifact) => artifact.id === selectedPreviewId) ?? previewVariants.at(-1)
  const annotations = useMemo(() => annotationsForActiveSession(snapshot), [snapshot])
  const openAnnotations = annotations.filter((annotation) => annotation.status === "open")
  const archiveReadOnly = sessionIsArchiveReadOnly(snapshot.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  ))
  const previewFrameRef = useRef<HTMLIFrameElement>(null)
  const stageContainerRef = useRef<HTMLDivElement>(null)
  const [stageContainerWidth, setStageContainerWidth] = useState(0)
  const [deviceWidth, setDeviceWidth] = useState(768)
  const [compareRequested, setCompareRequested] = useState(false)
  const reviewLayout = reviewLayoutFor(stageContainerWidth, compareRequested, previewVariants.length)
  const previewControlLayout = previewControlLayoutFor(stageContainerWidth)
  const reviewStageCount = reviewLayout.stages
  const reviewStages = useMemo(
    () => previewStagesForReview(previewVariants, preview, reviewStageCount),
    [preview, previewVariants, reviewStageCount],
  )
  const comparisonStages = useMemo(() => reviewStages.slice(1), [reviewStages])
  const previewAuthorizationKey = artifactAuthorizationKey(preview ? [preview] : [])
  const comparisonAuthorizationKey = artifactAuthorizationKey(comparisonStages)
  const [bridgeState, setBridgeState] = useState(() => ({
    previewKey: preview ? `${preview.id}:${preview.revision}` : undefined,
    channel: createPreviewBridgeChannel(),
  }))
  const previewKey = preview ? `${preview.id}:${preview.revision}` : undefined
  let bridgeChannel = bridgeState.channel
  if (bridgeState.previewKey !== previewKey) {
    const nextBridgeState = { previewKey, channel: createPreviewBridgeChannel() }
    bridgeChannel = nextBridgeState.channel
    setBridgeState(nextBridgeState)
  }
  const [pickerActive, setPickerActive] = useState(false)
  const [selection, setSelection] = useState<PreviewBridgeSelectionMessage | null>(null)
  const [selectionVisualContext, setSelectionVisualContext] = useState<
    RpcParams<"annotation.create">["visualContextUpload"]
  >()
  const [comment, setComment] = useState("")
  const [annotationPending, setAnnotationPending] = useState(false)
  const [annotationError, setAnnotationError] = useState("")
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [previewError, setPreviewError] = useState("")
  const [derivedArtifactPending, setDerivedArtifactPending] = useState<"print" | "download">()
  const [derivedArtifactError, setDerivedArtifactError] = useState("")
  const [comparisonStageUrls, setComparisonStageUrls] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  )
  const [previewThumbnailUrls, setPreviewThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map())
  const previewThumbnailLifecycle = useRef(new PreviewThumbnailLifecycle())
  const [anchorResolutions, setAnchorResolutions] = useState<ReadonlyMap<
    string,
    "selector" | "text-quote" | "bounding-box" | "unresolved"
  >>(() => new Map())
  const [bridgeReadyKey, setBridgeReadyKey] = useState<string>()
  const pendingAnchorResolutionBatch = useRef<PreviewBridgeResolveAnchorsMessage | undefined>(undefined)
  const queuedAnchorResolutionBatches = useRef<PreviewBridgeResolveAnchorsMessage[]>([])
  const [activeTab, setActiveTab] = useState<string>(defaultTab)
  const stageObservationKey = previewStageObservationKey(preview?.id, previewError)

  useEffect(() => {
    const element = stageContainerRef.current
    if (!element) return
    const update = () => setStageContainerWidth(element.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [stageObservationKey])

  useEffect(() => () => previewThumbnailLifecycle.current.clear(), [])

  useEffect(() => {
    let active = true
    setPreviewUrl(undefined)
    setPreviewError("")
    const [target] = artifactAuthorizationTargets(previewAuthorizationKey)
    if (!target || !connected) return () => { active = false }
    void authorizeArtifact({ sessionId: target.sessionId, artifactId: target.id, revision: target.revision, purpose: "preview", bridgeChannel, parentOrigin: window.location.origin }).then(
      (access) => {
        if (active) setPreviewUrl(artifactUrlFor(rpcUrl, access))
      },
      (cause: unknown) => {
        if (!active) return
        setPreviewUrl(undefined)
        setPreviewError(
          cause instanceof Error ? cause.message : "Preview access could not be authorized",
        )
      },
    )
    return () => { active = false }
  }, [authorizeArtifact, bridgeChannel, connected, previewAuthorizationKey, rpcUrl])

  useEffect(() => {
    let active = true
    setComparisonStageUrls(new Map())
    const targets = artifactAuthorizationTargets(comparisonAuthorizationKey)
    if (!targets.length || !connected) return () => { active = false }
    const authorizeComparisonStages = async () => {
      const entries: Array<readonly [string, string]> = []
      await Promise.all(targets.map(async (target) => {
        try {
          const access = await authorizeArtifact({
            sessionId: target.sessionId,
            artifactId: target.id,
            revision: target.revision,
            purpose: "preview",
          })
          entries.push([target.id, artifactUrlFor(rpcUrl, access)])
        } catch {
          // Keep failed comparison stages sandboxed and blank.
        }
      }))
      if (active) setComparisonStageUrls(new Map(entries))
    }
    void authorizeComparisonStages()
    return () => { active = false }
  }, [authorizeArtifact, comparisonAuthorizationKey, connected, rpcUrl])

  const postPickerState = useCallback((active: boolean) => {
    const message: PreviewBridgePickerMessage = {
      type: "domovoi.preview.picker",
      channel: bridgeChannel,
      active,
    }
    previewFrameRef.current?.contentWindow?.postMessage(message, "*")
  }, [bridgeChannel])

  const capturePreviewThumbnail = async () => {
    if (!captureAnnotation || !preview || !previewUrl) return
    const frame = previewFrameRef.current
    if (!frame) return
    const rect = previewThumbnailRect(frame.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight })
    if (!rect) return
    await capturePreviewThumbnailState({
      lifecycle: previewThumbnailLifecycle.current,
      artifactId: preview.id,
      revision: preview.revision,
      capture: () => captureAnnotation(rect),
      sync: setPreviewThumbnailUrls,
    })
  }

  const openDerivedArtifact = async (purpose: "print" | "download") => {
    if (!preview || !connected || derivedArtifactPending) return
    const printWindow = purpose === "print" ? window.open("about:blank", "_blank") : null
    if (printWindow) printWindow.opener = null
    setDerivedArtifactPending(purpose)
    setDerivedArtifactError("")
    try {
      const access = await authorizeArtifact({ sessionId: preview.sessionId, artifactId: preview.id, revision: preview.revision, purpose })
      const url = artifactUrlFor(rpcUrl, access)
      if (purpose === "print") {
        if (!printWindow) throw new Error("The browser blocked the print view")
        printWindow.location.replace(url)
      } else {
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = ""
        anchor.rel = "noopener noreferrer"
        anchor.click()
      }
    } catch (cause) {
      printWindow?.close()
      setDerivedArtifactError(cause instanceof Error ? cause.message : "The safe copy could not be prepared")
    } finally {
      setDerivedArtifactPending(undefined)
    }
  }

  const postNextAnchorResolutionBatch = useCallback(() => {
    if (pendingAnchorResolutionBatch.current) return
    const message = queuedAnchorResolutionBatches.current.shift()
    if (!message) return
    pendingAnchorResolutionBatch.current = message
    previewFrameRef.current?.contentWindow?.postMessage(message, "*")
  }, [])

  const startAnchorResolutionRequests = useCallback(() => {
    if (!preview) return
    queuedAnchorResolutionBatches.current = previewResolveAnchorMessages(
      bridgeChannel,
      preview.id,
      annotations
        .filter((annotation) => annotation.artifactId === preview.id)
        .map((annotation) => ({ annotationId: annotation.id, anchor: annotation.anchor })),
    )
    pendingAnchorResolutionBatch.current = undefined
    setAnchorResolutions(new Map())
    postNextAnchorResolutionBatch()
  }, [annotations, bridgeChannel, postNextAnchorResolutionBatch, preview])

  useEffect(() => {
    let active = true
    const receiveSelection = async (event: MessageEvent<unknown>) => {
      if (
        !preview
        || event.source !== previewFrameRef.current?.contentWindow
        || event.origin !== "null"
      ) return
      if (previewReadyFor(event.data, bridgeChannel, preview.id)) {
        setBridgeReadyKey(previewKey)
        return
      }
      const pendingBatch = pendingAnchorResolutionBatch.current
      const anchorResolutionMessage = pendingBatch
        ? anchorResolutionsFor(
            event.data,
            bridgeChannel,
            preview.id,
            pendingBatch.requestId,
            pendingBatch.annotations.map((annotation) => annotation.annotationId),
          )
        : undefined
      if (anchorResolutionMessage && pendingBatch) {
        setAnchorResolutions((current) => mergeAnchorResolutionBatch(
          current,
          anchorResolutionMessage.resolutions,
        ))
        pendingAnchorResolutionBatch.current = undefined
        postNextAnchorResolutionBatch()
        return
      }
      if (archiveReadOnly || !pickerActive) return
      const nextSelection = previewSelectionFor(event.data, bridgeChannel, preview.id)
      if (!nextSelection) return
      postPickerState(false)
      setPickerActive(false)
      let visualContextUpload: RpcParams<"annotation.create">["visualContextUpload"]
      const frame = previewFrameRef.current
      if (captureAnnotation && nextSelection.anchor.bbox && frame) {
        const frameRect = frame.getBoundingClientRect()
        visualContextUpload = await annotationCaptureUpload(
          captureAnnotation,
          { left: frameRect.left, top: frameRect.top, width: frameRect.width, height: frameRect.height },
          nextSelection.anchor.bbox,
          { width: window.innerWidth, height: window.innerHeight },
          preview.revision,
        )
      }
      if (!active) return
      setSelectionVisualContext(visualContextUpload)
      setSelection(nextSelection)
      setComment("")
      setAnnotationError("")
    }
    window.addEventListener("message", receiveSelection)
    return () => {
      active = false
      window.removeEventListener("message", receiveSelection)
    }
  }, [annotations, archiveReadOnly, bridgeChannel, captureAnnotation, pickerActive, postNextAnchorResolutionBatch, postPickerState, preview, previewKey])

  useEffect(() => {
    setPickerActive(false)
    setSelection(null)
    setSelectionVisualContext(undefined)
    setComment("")
    setAnnotationError("")
    setAnchorResolutions(new Map())
    setBridgeReadyKey(undefined)
    pendingAnchorResolutionBatch.current = undefined
    queuedAnchorResolutionBatches.current = []
  }, [archiveReadOnly, preview?.id, preview?.revision])

  useEffect(() => {
    if (bridgeReadyKey === previewKey) startAnchorResolutionRequests()
  }, [annotations, bridgeReadyKey, previewKey, startAnchorResolutionRequests])

  const togglePicker = () => {
    if (archiveReadOnly) return
    const active = !pickerActive
    setPickerActive(active)
    setAnnotationError("")
    postPickerState(active)
  }

  const saveAnnotation = async () => {
    const body = comment.trim()
    const sessionId = snapshot.activeSessionId
    if (archiveReadOnly || !body || !selection || !sessionId || annotationPending) return
    setAnnotationPending(true)
    setAnnotationError("")
    try {
      await onCreateAnnotation({
        sessionId,
        artifactId: selection.artifactId,
        anchor: selection.anchor,
        body,
        ...(preview?.variant ? { variantId: preview.variant.id } : {}),
        ...(selectionVisualContext ? { visualContextUpload: selectionVisualContext } : {}),
      })
      setSelection(null)
      setSelectionVisualContext(undefined)
      setComment("")
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The annotation could not be saved")
    } finally {
      setAnnotationPending(false)
    }
  }

  return (
    <aside aria-label="Session artifacts" data-workspace-panel="dock" className="flex h-full min-w-0 flex-col bg-sidebar">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full gap-0">
        <div className="flex h-11 items-center border-b px-2">
          <TabsList variant="line" className="min-w-0 flex-1 justify-start overflow-x-auto">
            <TabsTrigger value="plan"><FileTextIcon />Plan</TabsTrigger>
            <TabsTrigger value="changes"><FileDiffIcon />Changes</TabsTrigger>
            <TabsTrigger value="preview"><CodeXmlIcon />Preview</TabsTrigger>
            <TabsTrigger value="comments">
              <MessageSquareTextIcon />Comments
              {openAnnotations.length ? <Badge variant="outline" className="h-4 px-1 text-[8px]">{openAnnotations.length}</Badge> : null}
            </TabsTrigger>
            <TabsTrigger value="terminal"><TerminalSquareIcon />Terminal</TabsTrigger>
            <TabsTrigger value="history"><HistoryIcon />History</TabsTrigger>
            <TabsTrigger value="session"><BotIcon />Session</TabsTrigger>
          </TabsList>
          <Button ref={collapseButtonRef} variant="ghost" size="icon-xs" aria-label="Collapse dock" onClick={onCollapse}><PanelRightCloseIcon /></Button>
        </div>
        <TabsContent value="preview" className="min-h-0 overflow-auto p-3">
          {preview ? (
            <div className="flex min-h-full flex-col overflow-hidden rounded-xl border bg-background shadow-[var(--shadow-md)]">
              {previewVariants.length > 1 ? (
                <div className="border-b p-2">
                  <ScrollArea className="w-full whitespace-nowrap" aria-label="Design variants; use J and K or arrow keys to move">
                    <div className="flex gap-2 pb-2" onKeyDown={(event) => {
                      const direction = event.key === "j" || event.key === "ArrowRight" ? 1 : event.key === "k" || event.key === "ArrowLeft" ? -1 : 0
                      if (!direction) return
                      event.preventDefault()
                      const current = Math.max(0, previewVariants.findIndex((artifact) => artifact.id === preview.id))
                      setSelectedPreviewId(previewVariants[(current + direction + previewVariants.length) % previewVariants.length]?.id)
                    }}>
                      {previewVariants.map((artifact) => (
                        <Button key={artifact.id} variant={artifact.id === preview.id ? "secondary" : "outline"} className="min-h-11 min-w-28 flex-col items-start" aria-current={artifact.id === preview.id ? "true" : undefined} onClick={() => setSelectedPreviewId(artifact.id)}>
                          <PreviewVariantThumbnail url={previewThumbnailUrls.get(`${artifact.id}:${artifact.revision}`)} />
                          <span>{artifact.variant?.label ?? artifact.title}</span>
                          <span className="text-[9px] text-muted-foreground">{artifact.id === preview.id ? "Selected" : `revision ${artifact.revision}`}</span>
                        </Button>
                      ))}
                    </div>
                    <ScrollBar orientation="horizontal" />
                  </ScrollArea>
                </div>
              ) : null}
              <div className={cn("flex min-h-10 items-center justify-between gap-2 border-b px-3 py-1", previewToolbarLayoutFor(stageContainerWidth) === "wrap" && "flex-wrap")}>
                <div><p className="m-0 text-[11px] font-medium">{preview.title}</p><p className="m-0 font-machine text-[9px] text-faint">revision {preview.revision} · sandboxed</p></div>
                <div className={cn("flex min-w-0 items-center justify-end gap-2", previewControlLayout.wrap && "flex-wrap", previewControlLayout.fullWidth && "w-full")}>
                  <Button variant="outline" size="xs" className="min-h-11" disabled={!connected || Boolean(derivedArtifactPending)} aria-label="Open sanitized print view" onClick={() => void openDerivedArtifact("print")}><PrinterIcon data-icon="inline-start" />{derivedArtifactPending === "print" ? "Preparing" : "Print view"}</Button>
                  <Button variant="outline" size="xs" className="min-h-11" disabled={!connected || Boolean(derivedArtifactPending)} aria-label="Download sanitized offline HTML copy" onClick={() => void openDerivedArtifact("download")}><DownloadIcon data-icon="inline-start" />{derivedArtifactPending === "download" ? "Preparing" : "Download safe copy"}</Button>
                  <ToggleGroup type="single" value={String(deviceWidth)} onValueChange={(value) => { if (value) setDeviceWidth(Number(value)) }} aria-label="Preview device width">
                    {[390, 768, 1440].map((width) => <ToggleGroupItem key={width} value={String(width)} className="min-h-11 min-w-11" aria-label={`${width} pixel preview`}>{width}</ToggleGroupItem>)}
                  </ToggleGroup>
                  {previewVariants.length > 1 ? <Button variant="outline" size="xs" className="min-h-11" aria-pressed={reviewLayout.compare} disabled={stageContainerWidth > 0 && stageContainerWidth < 760} onClick={() => setCompareRequested((value) => !value)}>Compare</Button> : null}
                  {previewVariants.length > 1 && stageContainerWidth > 0 && stageContainerWidth < 760 ? <span className="sr-only" role="status">Compare is unavailable at this width; showing the selected variant.</span> : null}
                  {!archiveReadOnly ? (
                    <Button
                      variant={pickerActive ? "secondary" : "outline"}
                      size="xs"
                      className="min-h-11"
                      aria-pressed={pickerActive}
                      onClick={togglePicker}
                    >
                      <MessageSquarePlusIcon />
                      {pickerActive ? "Select element" : "Annotate"}
                    </Button>
                  ) : null}
                  <Badge variant="success">Live</Badge>
                </div>
              </div>
              <p className="m-0 border-b px-3 py-1 text-[9px] text-muted-foreground">Safe copies remove scripts, forms, and external assets.</p>
              {derivedArtifactError ? <Alert variant="destructive" className="m-3 w-auto" aria-live="polite"><CircleStopIcon /><AlertTitle>Safe copy unavailable</AlertTitle><AlertDescription>{derivedArtifactError}</AlertDescription></Alert> : null}
              {previewError ? (
                <Alert variant="destructive" className="m-3 w-auto" aria-live="polite">
                  <CircleStopIcon />
                  <AlertTitle>Preview unavailable</AlertTitle>
                  <AlertDescription>{previewError}</AlertDescription>
                </Alert>
              ) : (
                <div
                  ref={stageContainerRef}
                  className="grid min-h-0 flex-1 gap-3 overflow-auto p-2"
                  style={{ gridTemplateColumns: previewStageGridColumns(reviewLayout.stages) }}
                >
                {reviewStages.map((artifact, index) => (
                  <iframe
                    key={artifact.id}
                    ref={index === 0 ? previewFrameRef : undefined}
                    className="min-h-0 w-full justify-self-center border bg-background"
                    style={{ maxWidth: deviceWidth }}
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts"
                    src={index === 0 ? previewUrl ?? "about:blank" : comparisonStageUrls.get(artifact.id) ?? "about:blank"}
                    title={index === 0 ? artifact.title : `${artifact.title} comparison`}
                    onLoad={index === 0 ? () => {
                      postPickerState(pickerActive)
                      void capturePreviewThumbnail()
                    } : undefined}
                  />
                ))}
                </div>
              )}
            </div>
          ) : (
            <Empty className="min-h-full border">
              <EmptyHeader><EmptyMedia variant="icon"><CodeXmlIcon /></EmptyMedia><EmptyTitle>No preview yet</EmptyTitle><EmptyDescription>HTML artifacts created by the agent appear here.</EmptyDescription></EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="plan" className="min-h-0">
          {plan?.content ? (
            <ScrollArea className="h-full">
              <article className="p-4">
                <div className="mb-4 border-b pb-3">
                  <h2 className="m-0 text-[13px] font-semibold">{plan.title}</h2>
                  <p className="mt-1 font-machine text-[9px] text-faint">revision {plan.revision}</p>
                </div>
                <MarkdownQuickView source={plan.content} canonicalAvailable={Boolean(preview)} onOpenCanonical={() => setActiveTab("preview")} />
              </article>
            </ScrollArea>
          ) : (
            <Empty className="min-h-full border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                <EmptyTitle>No plan content yet</EmptyTitle>
                <EmptyDescription>Plan updates from the active agent appear here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="changes" className="min-h-0">
          <SessionEvidencePanel
            connected={connected}
            readOnly={archiveReadOnly}
            sessionId={snapshot.activeSessionId}
            onLoad={onLoadSessionEvidence}
            onRevertFile={onRevertSessionFile}
          />
        </TabsContent>
        <TabsContent value="comments" className="min-h-0">
          <AnnotationComments
            annotations={annotations}
            anchorResolutions={anchorResolutions}
            readOnly={archiveReadOnly}
            onReply={onReplyToAnnotation}
            onSetStatus={onSetAnnotationStatus}
          />
        </TabsContent>
        <TabsContent value="terminal" className="min-h-0 bg-code">
          <Suspense fallback={(
            <Empty className="min-h-full border-0 text-muted-foreground">
              <EmptyHeader>
                <EmptyMedia variant="icon"><TerminalSquareIcon /></EmptyMedia>
                <EmptyTitle>Loading terminal</EmptyTitle>
                <EmptyDescription>Preparing the interactive terminal renderer.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}>
            <TerminalPane
              connected={connected}
              controls={terminalControls}
              machineName={snapshot.machine.name}
              sessionId={snapshot.activeSessionId}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="history" className="min-h-0">
          <HistoryPanel
            sessionId={snapshot.activeSessionId}
            connected={connected}
            onLoad={onLoadSessionHistory}
          />
        </TabsContent>
        <TabsContent value="session" className="p-4 font-machine text-[11px] text-muted-foreground">{snapshot.machine.name}<br />{snapshot.project?.path ?? "No project open"}</TabsContent>
      </Tabs>
      <Dialog
        open={!archiveReadOnly && selection !== null}
        onOpenChange={(open) => {
          if (open || annotationPending) return
          setSelection(null)
          setSelectionVisualContext(undefined)
          setComment("")
          setAnnotationError("")
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annotate preview</DialogTitle>
            <DialogDescription className="break-words">
              {selection?.label ?? "Selected preview element"}
            </DialogDescription>
          </DialogHeader>
          {annotationError ? (
            <Alert variant="destructive" aria-live="polite">
              <CircleStopIcon />
              <AlertTitle>Annotation failed</AlertTitle>
              <AlertDescription>{annotationError}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="preview-annotation">Comment</FieldLabel>
              <Textarea
                id="preview-annotation"
                value={comment}
                rows={4}
                autoFocus
                disabled={annotationPending}
                placeholder="Describe what should change or what needs review"
                onChange={(event) => setComment(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={annotationPending}
              onClick={() => setSelection(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!comment.trim() || annotationPending}
              onClick={() => void saveAnnotation()}
            >
              {annotationPending ? "Saving annotation" : "Save annotation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

export function AnnotationComments({
  annotations,
  anchorResolutions = new Map(),
  readOnly,
  onReply,
  onSetStatus,
}: {
  annotations: Annotation[]
  anchorResolutions?: ReadonlyMap<string, "selector" | "text-quote" | "bounding-box" | "unresolved">
  readOnly: boolean
  onReply: (annotationId: string, body: string) => Promise<void>
  onSetStatus: (annotationId: string, status: Annotation["status"]) => Promise<void>
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState("")

  const submitReply = async (annotationId: string) => {
    const body = reply.trim()
    if (!body || pendingId) return
    setPendingId(annotationId)
    setError("")
    try {
      await onReply(annotationId, body)
      setReply("")
      setReplyingTo(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The annotation reply could not be saved")
    } finally {
      setPendingId(null)
    }
  }

  const setStatus = async (annotation: Annotation) => {
    if (pendingId) return
    setPendingId(annotation.id)
    setError("")
    try {
      await onSetStatus(annotation.id, annotation.status === "open" ? "resolved" : "open")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The annotation status could not be changed")
    } finally {
      setPendingId(null)
    }
  }

  return (
    <ScrollArea className="h-full">
      {annotations.length ? (
        <div className="flex flex-col gap-3 p-3">
          {error ? (
            <Alert variant="destructive" aria-live="polite">
              <CircleStopIcon />
              <AlertTitle>Annotation update failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {annotations.map((annotation) => {
            const pending = pendingId === annotation.id
            const isReplying = replyingTo === annotation.id
            const anchorResolution = anchorResolutions.get(annotation.id)
            return (
              <Card key={annotation.id} size="sm">
                <CardHeader>
                  <CardTitle className="min-w-0 break-words text-[12px] leading-relaxed">{annotation.body}</CardTitle>
                  <CardDescription className="font-machine text-[9px]">
                    {annotation.origin} · {annotation.variantId ?? annotation.artifactId}
                    {annotation.statusChangedBy ? ` · ${annotation.status} by ${annotation.statusChangedBy}` : ""}
                  </CardDescription>
                  <CardAction>
                    <Badge variant={annotation.status === "open" ? "warning" : "success"}>{annotation.status}</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <div className="break-words rounded-md border bg-code px-2.5 py-2 font-machine text-[9px] leading-relaxed text-muted-foreground">
                    {annotation.anchor.textQuote
                      ? `“${annotation.anchor.textQuote}”`
                      : annotation.anchor.cssSelector ?? "Visual selection"}
                    {anchorResolution ? (
                      <Badge
                        variant={anchorResolution === "unresolved" ? "destructive" : "outline"}
                        className="ml-2"
                      >
                        {anchorResolution === "selector" ? "selector anchor" : null}
                        {anchorResolution === "text-quote" ? "text anchor" : null}
                        {anchorResolution === "bounding-box" ? "visual anchor" : null}
                        {anchorResolution === "unresolved" ? "anchor unavailable" : null}
                      </Badge>
                    ) : null}
                  </div>
                  {annotation.visualContext ? (
                    <p className="m-0 font-machine text-[9px] text-faint">
                      {annotation.visualContext.status === "available"
                        ? `visual context · ${annotation.visualContext.width}×${annotation.visualContext.height} · revision ${annotation.visualContext.artifactRevision}`
                        : `visual context unavailable · ${annotation.visualContext.reason}`}
                    </p>
                  ) : null}
                  {annotation.thread.map((threadReply) => (
                    <div key={threadReply.id} className="break-words border-l border-border pl-2 text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-machine text-[9px] text-faint">{threadReply.origin}</span><br />
                      {threadReply.body}
                    </div>
                  ))}
                </CardContent>
                {!readOnly ? <CardFooter className="flex-col items-stretch gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={pendingId !== null || (replyingTo !== null && !isReplying)}
                      onClick={() => {
                        setError("")
                        setReply("")
                        setReplyingTo(isReplying ? null : annotation.id)
                      }}
                    >
                      {isReplying ? "Cancel reply" : "Reply"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pendingId !== null}
                      onClick={() => void setStatus(annotation)}
                    >
                      {pending ? "Saving" : annotation.status === "open" ? "Resolve" : "Reopen"}
                    </Button>
                  </div>
                  {isReplying ? (
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor={`annotation-reply-${annotation.id}`}>Reply</FieldLabel>
                        <Textarea
                          id={`annotation-reply-${annotation.id}`}
                          value={reply}
                          rows={3}
                          disabled={pending}
                          placeholder="Add context for the next agent round"
                          onChange={(event) => setReply(event.target.value)}
                        />
                      </Field>
                      <Button
                        size="sm"
                        disabled={!reply.trim() || pending}
                        onClick={() => void submitReply(annotation.id)}
                      >
                        {pending ? "Saving reply" : "Save reply"}
                      </Button>
                    </FieldGroup>
                  ) : null}
                </CardFooter> : null}
              </Card>
            )
          })}
        </div>
      ) : (
        <Empty className="min-h-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><MessageSquareTextIcon /></EmptyMedia>
            <EmptyTitle>No annotations yet</EmptyTitle>
            <EmptyDescription>Comments anchored to plans and previews appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </ScrollArea>
  )
}

function SidebarRail({
  snapshot,
  onActivate,
  onExpand,
  onOpenProviderSettings,
  expandButtonRef,
}: {
  snapshot: WorkspaceSnapshot
  onActivate: (sessionId: string) => void
  onExpand: () => void
  onOpenProviderSettings: () => void
  expandButtonRef?: RefObject<HTMLButtonElement | null>
}) {
  return (
    <aside aria-label="Collapsed sessions" data-workspace-panel="sessions-rail" className="flex w-[46px] shrink-0 flex-col items-center gap-2 border-r bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button ref={expandButtonRef} variant="ghost" size="icon-sm" aria-label="Expand sessions" onClick={onExpand}><PanelLeftCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="right">Expand sessions</TooltipContent></Tooltip>
      <Separator />
      {snapshot.sessions.map((session) => <Tooltip key={session.id}><TooltipTrigger asChild><button type="button" aria-label={`${session.title}. Status: ${session.state}`} aria-pressed={session.id === snapshot.activeSessionId} onClick={() => onActivate(session.id)} className={cn("flex size-7 items-center justify-center rounded-md hover:bg-accent", session.id === snapshot.activeSessionId && "bg-accent")}><span aria-hidden="true" data-status-dot="" className={cn("size-2 rounded-full", statusClass[session.state])} /></button></TooltipTrigger><TooltipContent side="right">{session.title} · {session.state}</TooltipContent></Tooltip>)}
      <span className="flex-1" />
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={providerSettingsNavigationLabel} onClick={onOpenProviderSettings}><SettingsIcon /></Button></TooltipTrigger><TooltipContent side="right">{providerSettingsNavigationLabel}</TooltipContent></Tooltip>
    </aside>
  )
}

function DockRail({ onExpand, expandButtonRef }: { onExpand: () => void; expandButtonRef?: RefObject<HTMLButtonElement | null> }) {
  const items = [FileDiffIcon, CodeXmlIcon, MessageSquareTextIcon, TerminalSquareIcon, HistoryIcon]
  return (
    <aside aria-label="Collapsed artifact dock" data-workspace-panel="dock-rail" className="flex w-[46px] shrink-0 flex-col items-center gap-2 border-l bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button ref={expandButtonRef} variant="ghost" size="icon-sm" aria-label="Expand artifact dock" onClick={onExpand}><PanelRightCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="left">Expand artifact dock</TooltipContent></Tooltip>
      <Separator />
      {items.map((Icon, index) => <Button key={index} variant="ghost" size="icon-sm" aria-label="Artifact dock item" onClick={onExpand}><Icon /></Button>)}
    </aside>
  )
}

export function WorkspaceShell({ clientKind = "web", rpcUrl = "ws://127.0.0.1:47831/rpc", rpcToken, windowBridge, onChangeCredential }: WorkspaceShellProps) {
  const [machineSwitch, setMachineSwitch] = useState<MachineSwitchState>(homeMachineSwitch)
  const attached = machineSwitch.state === "attached" ? machineSwitch.target : null
  const activeRpcUrl = attached?.endpoint ?? rpcUrl
  const activeRpcToken = attached?.credential ?? rpcToken
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
    forkSession,
    getSkillInventory,
    createTerminal,
    listDevices,
    listFleet,
    listModels,
    listProviderSecrets,
    listSkills,
    exportAudit,
    loadSessionHistory,
    loadSessionEvidence,
    machineCredential,
    openProject,
    pairMachine,
    pauseSession,
    queryAudit,
    readSkill,
    refreshProviders,
    reconnect,
    restoreCheckpoint,
    revertSessionFile,
    restartProviderThread,
    resizeTerminal,
    resolveApproval,
    replyToAnnotation,
    revokeDevice,
    rotateDevice,
    reviewSkill,
    sendMessage,
    sessionUsage,
    setSkillEnabled,
    setRuntime,
    setAnnotationStatus,
    snapshot,
    subscribeTerminal,
    terminalClientId,
    transferSession,
    writeTerminal,
    authenticationRequired,
    protocolError,
    reconnecting,
  } = useWorkspace(activeRpcUrl, clientKind, activeRpcToken)
  const terminalControls = useMemo<TerminalControls>(() => ({
    clientId: terminalClientId,
    create: createTerminal,
    claim: claimTerminal,
    write: writeTerminal,
    resize: resizeTerminal,
    close: closeTerminal,
    subscribe: subscribeTerminal,
  }), [claimTerminal, closeTerminal, createTerminal, resizeTerminal, subscribeTerminal, terminalClientId, writeTerminal])
  // The machine reached through the credential this client started with, which
  // is where selecting it again returns to.
  const [homeMachineId, setHomeMachineId] = useState<string | null>(null)
  useEffect(() => {
    if (machineSwitch.state !== "home" || !snapshot) return
    setHomeMachineId(snapshot.machine.id)
  }, [machineSwitch.state, snapshot])

  const [fleet, setFleet] = useState<FleetMachine[] | null>(null)
  useEffect(() => {
    if (!connected) return
    let active = true
    void listFleet().then(
      (snapshot) => {
        if (active) setFleet(snapshot.machines)
      },
      () => {
        // A daemon that cannot describe its fleet still runs this machine, so
        // the menu falls back to naming this machine alone.
        if (active) setFleet(null)
      },
    )
    return () => {
      active = false
    }
  }, [connected, listFleet])

  const switchMachine = useCallback((machineId: string) => {
    if (machineId === homeMachineId) {
      setMachineSwitch(homeMachineSwitch)
      return
    }
    const machine = fleet?.find((candidate) => candidate.id === machineId)
    if (!machine) return
    setMachineSwitch((current) => beganMachineSwitch(current, machineId, homeMachineId ?? undefined))
    void resolveMachineTarget({
      machine,
      readCredential: async (id) => (await machineCredential({ machineId: id })).credential,
      connect: async ({ candidates, credential }) => {
        const opened = await connectMachineClient({ candidates, credential, kind: clientKind })
        return { transport: opened.transport, close: () => opened.client.disconnect() }
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }).then(
      (target) => setMachineSwitch((current) => attachedMachineSwitch(current, target)),
      (error: unknown) => setMachineSwitch((current) => failedMachineSwitch(
        current,
        error instanceof Error ? error.message : "That machine could not be opened",
        machineId,
      )),
    )
  }, [clientKind, fleet, homeMachineId, machineCredential])

  const shellRef = useRef<HTMLDivElement>(null)
  const sidebarCollapseButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarExpandButtonRef = useRef<HTMLButtonElement>(null)
  const dockCollapseButtonRef = useRef<HTMLButtonElement>(null)
  const dockExpandButtonRef = useRef<HTMLButtonElement>(null)
  const notificationTrackerRef = useRef(new WorkspaceNotificationTracker())
  const commandPaletteFocusRef = useRef<HTMLElement | null>(null)
  const deepLinkRoutingRef = useRef(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [requestedSkillId, setRequestedSkillId] = useState<string>()
  const [pendingDeepLinks, setPendingDeepLinks] = useState<string[]>([])
  const [launcherMode, setLauncherMode] = useState<LauncherMode>(null)
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
    externalEditor,
    layouts,
    sidebarCollapsed,
    surface,
    theme,
    windowDecoration,
  } = workspaceUi
  const [activeWindowDecoration, setActiveWindowDecoration] = useState<WorkspaceWindowDecoration>("domovoi")
  useAppearanceTheme(theme)
  const commandPlatform: CommandPalettePlatform = windowBridge?.platform
    ?? (typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "darwin" : "linux")
  const setSidebarCollapsed = (collapsed: boolean) => {
    const activePanel = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement.closest("[data-workspace-panel]")?.getAttribute("data-workspace-panel")
      : null
    setWorkspaceUi((current) => ({ ...current, sidebarCollapsed: collapsed }))
    if ((collapsed && activePanel === "sessions") || (!collapsed && activePanel === "sessions-rail")) {
      restoreFocusAfterUpdate(collapsed ? sidebarExpandButtonRef : sidebarCollapseButtonRef)
    }
  }
  const setDockCollapsed = (collapsed: boolean) => {
    const activePanel = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement.closest("[data-workspace-panel]")?.getAttribute("data-workspace-panel")
      : null
    setWorkspaceUi((current) => ({ ...current, dockCollapsed: collapsed }))
    if ((collapsed && activePanel === "dock") || (!collapsed && activePanel === "dock-rail")) {
      restoreFocusAfterUpdate(collapsed ? dockExpandButtonRef : dockCollapseButtonRef)
    }
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
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState("")
  const [skillsRefresh, setSkillsRefresh] = useState(0)
  const [activeSessionUsage, setActiveSessionUsage] = useState<SessionUsage | null>(null)
  const activeWorkspacePath = snapshot?.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  )?.workspacePath
  const skillMachineKey = skillInventoryRefreshKey(snapshot)
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
  const pauseActiveTurns = () => {
    void emergencyStop()
  }
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
    if (!windowBridge) {
      setLauncherMode("project")
      return
    }
    setWorkspaceError("")
    void openProjectFromDesktop(windowBridge, openProjectSafely).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "Domovoi could not open the selected project")
    })
  }
  const openActiveWorkspaceInEditor = () => {
    if (!windowBridge || !activeWorkspacePath) return
    setWorkspaceError("")
    void openDesktopPath(windowBridge, activeWorkspacePath, externalEditor).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "External editor could not open the worktree")
    })
  }
  const copyActiveWorkspacePath = () => {
    if (!windowBridge || !activeWorkspacePath) return
    setWorkspaceError("")
    void copyDesktopText(windowBridge, activeWorkspacePath).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "Clipboard text could not be copied")
    })
  }
  const openCommandPalette = () => {
    commandPaletteFocusRef.current = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setCommandPaletteOpen(true)
  }
  const workspaceCommands = buildWorkspaceCommands({
    ...(windowBridge && activeWorkspacePath ? {
      activeWorkspacePath,
      copyWorktreePath: copyActiveWorkspacePath,
      openInEditor: openActiveWorkspaceInEditor,
      externalEditor,
    } : {}),
    connected,
    emergencyStopPending,
    hasProject: Boolean(snapshot?.project),
    openProject: requestOpenProject,
    newSession: () => setLauncherMode(snapshot?.project ? "session" : "project"),
    pauseAll: pauseActiveTurns,
    reconnect: reconnectDaemon,
    setSurface,
    sessions: snapshot?.sessions ?? [],
    machines: fleet,
    skills,
    activateSession: (sessionId) => {
      setSurface("workspace")
      activateVisibleSession(sessionId)
    },
    selectMachine: switchMachine,
    openSkill: (skillId) => {
      setRequestedSkillId(skillId)
      setSurface("skills")
    },
  })
  const usageSessionId = snapshot?.activeSessionId ?? null
  const usageFetchKey = sessionUsageFetchKey(snapshot)
  const layoutKey = `${sidebarCollapsed ? "rail" : "sidebar"}.${dockCollapsed ? "rail" : "dock"}`
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
    if (!windowBridge) return
    for (const notification of notifications) {
      void windowBridge.notify(notification).catch(() => {})
    }
  }, [snapshot, windowBridge])

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

  useEffect(() => {
    if (surface !== "skills") return
    if (!connected) {
      setSkillsLoading(false)
      setSkillInventories(skillMachine ? [{
        state: "unreachable",
        machine: skillMachine,
      }] : [])
      setSkillsError("Reconnect to the execution machine to refresh its skill directories.")
      return
    }
    let active = true
    setSkillsLoading(true)
    setSkillsError("")
    void Promise.all([listSkills(), getSkillInventory()]).then(
      async ([discovered, inventory]) => {
        if (!active) return
        setSkills(discovered)
        // This machine answers first so the card is never empty while the
        // fleet is still being asked.
        setSkillInventories([{ state: "available", inventory }])
        const sources = await collectFleetInventories({
          local: inventory,
          fleet,
          open: async (machine) => {
            const opened = await openMachine({
              machine,
              readCredential: async (id) => (await machineCredential({ machineId: id })).credential,
              connect: ({ candidates, credential }) =>
                connectMachineClient({ candidates, credential, kind: clientKind }),
              wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              attempts: 1,
            })
            return {
              inventory: () => opened.client.getSkillInventory(),
              close: () => opened.client.disconnect(),
            }
          },
        })
        if (active) setSkillInventories(sources)
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
    return () => { active = false }
  }, [
    clientKind,
    connected,
    fleet,
    getSkillInventory,
    listSkills,
    machineCredential,
    skillMachine,
    skillsRefresh,
    surface,
  ])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? shell.clientWidth
      if (width < 1080) setDockCollapsed(true)
      if (width < 850) setSidebarCollapsed(true)
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  return (
    <TooltipProvider>
      <div ref={shellRef} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <AppBar snapshot={snapshot} connected={connected} emergencyStopPending={emergencyStopPending} emergencyStopOutcome={emergencyStopOutcome} emergencyStopError={emergencyStopError} bridge={windowBridge} windowDecoration={activeWindowDecoration} onOpenProject={requestOpenProject} onPauseAll={pauseActiveTurns} onOpenCommands={openCommandPalette} commandShortcut={commandPlatform === "darwin" ? "⌘K" : "Ctrl+K"} />
        <WorkspaceConnectionStatus
          connected={connected}
          reconnecting={reconnecting}
          authenticationRequired={authenticationRequired}
          protocolError={protocolError}
          connectionError={connectionError}
          machineName={snapshot?.machine.name}
          onChangeCredential={onChangeCredential}
          onReconnect={reconnectDaemon}
        />
        {snapshot && surface === "providers" ? (
          <ProviderSettings
            providers={snapshot.machine.providers}
            secrets={providerSecrets}
            onBack={() => setSurface("workspace")}
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
        ) : snapshot && surface === "skills" ? (
          <SkillBrowser
            skills={skills}
            inventorySources={skillInventories}
            loading={skillsLoading}
            error={skillsError}
            onBack={() => setSurface("workspace")}
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
            onRetry={() => setSkillsRefresh((current) => current + 1)}
          />
        ) : snapshot && surface === "fleet" ? (
          <FleetView
            connected={connected}
            machines={fleet ?? [localMachineEntry(snapshot)]}
            currentMachineId={attached?.machineId ?? snapshot.machine.id}
            currentSessionCount={activeSessionCount(snapshot)}
            onBack={() => setSurface("workspace")}
            onOpenSkills={() => setSurface("skills")}
            onListDevices={listDevices}
            onRevokeDevice={revokeDevice}
            onRotateDevice={rotateDevice}
            onPairMachine={pairMachine}
          />
        ) : snapshot && surface === "audit" ? (
          <AuditLogView
            connected={connected}
            onBack={() => setSurface("workspace")}
            onOpenSkills={() => setSurface("skills")}
            onQuery={queryAudit}
            onExport={exportAudit}
          />
        ) : snapshot ? (
          <div className="flex min-h-0 flex-1">
            {sidebarCollapsed ? <SidebarRail snapshot={snapshot} onActivate={activateVisibleSession} onExpand={() => setSidebarCollapsed(false)} onOpenProviderSettings={() => setSurface("providers")} expandButtonRef={sidebarExpandButtonRef} /> : null}
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
              {!sidebarCollapsed ? <><ResizablePanel id="sessions" defaultSize="20" minSize="14" maxSize="28"><SessionsSidebar snapshot={snapshot} fleet={fleet} onCollapse={() => setSidebarCollapsed(true)} onActivate={activateVisibleSession} onNewSession={() => snapshot.project ? setLauncherMode("session") : requestOpenProject()} onOpenProviderSettings={() => setSurface("providers")} collapseButtonRef={sidebarCollapseButtonRef} /></ResizablePanel><ResizableHandle withHandle aria-label="Resize sessions and thread" /></> : null}
              <ResizablePanel id="thread" defaultSize={sidebarCollapsed && dockCollapsed ? "100" : "48"} minSize="34"><Thread key={activeThreadKey(snapshot)} snapshot={snapshot} connected={connected} emergencyStopPending={emergencyStopPending} onResolve={resolveApproval} onSetRuntime={(runtime) => snapshot.activeSessionId ? setRuntime(snapshot.activeSessionId, runtime) : Promise.reject(new Error("No session is active"))} onRestartProviderThread={() => snapshot.activeSessionId ? restartProviderThread(snapshot.activeSessionId) : Promise.reject(new Error("No session is active"))} onForkSession={forkSession} onListModels={listModels} onNewSession={() => snapshot.project ? setLauncherMode("session") : requestOpenProject()} onSend={sendMessage} onCheckpoint={createCheckpoint} onRestoreCheckpoint={restoreCheckpoint} onPauseSession={pauseSession} onArchiveSession={archiveSession} onPairMachine={pairMachine} fleet={fleet ?? undefined} currentMachineId={attached?.machineId ?? snapshot.machine.id} onSelectMachine={switchMachine} onTransferSession={transferSession} externalEditor={externalEditor} usage={activeSessionUsage} {...(windowBridge ? { onOpenExternal: (path: string) => openDesktopPath(windowBridge, path, externalEditor) } : {})} /></ResizablePanel>
              {!dockCollapsed ? <><ResizableHandle withHandle aria-label="Resize thread and artifact dock" /><ResizablePanel id="dock" defaultSize="32" minSize="24" maxSize="46"><ArtifactDock snapshot={snapshot} onCollapse={() => setDockCollapsed(true)} collapseButtonRef={dockCollapseButtonRef} defaultTab={clientKind === "desktop" ? "changes" : "preview"} rpcUrl={activeRpcUrl} authorizeArtifact={authorizeArtifact} connected={connected} terminalControls={terminalControls} onCreateAnnotation={createAnnotation} onLoadSessionHistory={loadSessionHistory} onLoadSessionEvidence={loadSessionEvidence} onRevertSessionFile={revertSessionFile} onReplyToAnnotation={replyToAnnotation} onSetAnnotationStatus={setAnnotationStatus} {...(windowBridge ? { captureAnnotation: windowBridge.captureAnnotation } : {})} /></ResizablePanel></> : null}
            </ResizablePanelGroup>
            {dockCollapsed ? <DockRail onExpand={() => setDockCollapsed(false)} expandButtonRef={dockExpandButtonRef} /> : null}
          </div>
        ) : (
          <main className="flex min-h-0 flex-1 bg-background">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><DomovoiMark reduced className="size-5" /></EmptyMedia>
                <EmptyTitle asChild><h1>Connecting to the daemon</h1></EmptyTitle>
                <EmptyDescription>Domovoi will show workspace state after the execution machine responds.</EmptyDescription>
              </EmptyHeader>
            </Empty>
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
