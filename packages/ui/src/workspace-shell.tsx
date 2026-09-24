import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { CircleStopIcon, PinIcon } from "lucide-react"
import type {
  ClientKind,
  PermissionMode,
  ProjectSwitchConfirmation,
  SkillSummary,
  SkillInventorySource,
  SessionUsage,
  SessionTurn,
  SystemEmergencyStopResult,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { selectableTurnSkills, turnSkillSelectionFor } from "@getdomovoi/protocol"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { StateRecoveryNotice } from "./state-recovery-notice"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog"
import { Button } from "./components/ui/button"
import { WorkspaceConnectionStatus } from "./connection-status"
import { shouldCollapseDockForWidth } from "./dock-auto-collapse"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable"
import { fleetMachines } from "./fleet-entries.js"
import { machineAttachment } from "./machine-selection.js"
import { TooltipProvider } from "./components/ui/tooltip"
import { DaemonRpcError, ProjectSwitchConfirmationError } from "./client"
import { SessionsDrawerColumn, SessionsDrawerTrigger, type SessionRowAction } from "./sessions-drawer"
import { useWorkspace } from "./use-workspace"
import type { RelayPinStorage } from "./relay-pin"
import { FleetAccessSession } from "./fleet-access-session"
import { ClientAdmissionError } from "./client-admission-policy"
import { prepareFleetEndpoint, withinFleetDeadline } from "./fleet-access"
import { Deadline } from "./deadline"
import { advancePendingElsewhere, paletteSearchTargets, type PendingElsewhere } from "./palette-search-targets"
import { collectFleetInventories } from "./fleet-inventories"
import { sessionUsageFetchKey, usageWindowFetchKey } from "./session-usage"
import { type ProviderSecretStatus } from "./provider-settings"
import type { LocalDaemonDescription } from "./settings-shell"
import { lazySurface, prefetchWhenIdle, SurfaceCodeReload } from "./lazy-surface"
import { ThreadSkeleton } from "./loading-skeleton"
import { MachineSheet } from "./machine-sheet"
import { CheckpointFork, CheckpointRestore, CheckpointRestoreAction, checkpointBlockedReason, checkpointRestoreBlocked } from "./checkpoint-actions.js"
import { latestTurnFromHistory } from "./usage-chip.js"
import {
  failedAttempt,
  heldAfter,
  holdAllAfterStop,
  provesNothingRan,
  releasableQueues,
  setQueue,
  type FailedAttempt,
  type SessionQueues,
} from "./turn-queue"
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
import { preferredSessionProvider } from "./runtime"
import type { TerminalControls } from "./terminal-pane"
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
import { colorSchemeQuery, resolveAppearanceTheme, useAppearanceTheme, type WorkspaceTheme } from "./appearance"
import { WorkspaceNotificationTracker, type DesktopNotificationRequest } from "./desktop-notifications"
import {
  copyDesktopText,
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
import { ArtifactDock } from "./artifact-dock"
import {
  activeSession,
  activeSessionCount,
  activeThreadKey,
  localFleetEntry,
} from "./workspace-selectors"
import { LauncherDialog, type LauncherMode, ProjectSwitchConfirmationDialog } from "./launcher-dialog"
import { AppBar, useUsageToday } from "./app-bar"
import { ArchiveConfirmBody, Thread, archiveSessionDescription } from "./thread"

export { ArchiveSessionAction, CheckpointThreadItem, SessionReadOnlyNotice, SessionRow, type SessionTransferReceipt, Thread, archiveSessionDescription, providerFailureActionCopy, sessionStatusMeaning, sessionTransferReceiptText } from "./thread"

export { AppBar, emergencyStopAnnouncement, useUsageToday } from "./app-bar"

export { LauncherDialog, ProjectSwitchConfirmationDialog, ProviderReadinessList, ProviderSearchReport } from "./launcher-dialog"

export { activeSession, activeSessionCount, activeThreadKey, forkSessionBlockedReason, renderedThreadForActiveSession, sessionIsArchiveReadOnly } from "./workspace-selectors"
export { AnnotationComments, ArtifactDock, PreviewVariantThumbnail, artifactAuthorizationKey, capturePreviewThumbnailState } from "./artifact-dock"
export { HistoryPanel } from "./history-panel"

import { restoreFocusAfterUpdate } from "./restore-focus"
export { restoreFocusAfterUpdate } from "./restore-focus"

const watchingMutationCommands = new Set([
  "open-project",
  "new-session",
  "open-in-editor",
  "pause-all",
  "emergency-stop",
  "reconnect",
])

// The shell opens on a thread. These surfaces load when one is first opened,
// or at idle after the shell has painted, so a launch does not download, parse
// and compile them first.
const settingsSurface = lazySurface("Settings", async () => (await import("./settings-shell")).SettingsShell)
const skillsSurface = lazySurface("Skills", async () => (await import("./skill-browser")).SkillBrowser)
const machinesSurface = lazySurface("Machines", async () => (await import("./fleet-view")).FleetView)
const auditSurface = lazySurface("Audit log", async () => (await import("./audit-log-view")).AuditLogView)
const lazySurfaces = [settingsSurface, skillsSurface, machinesSurface, auditSurface]
const SettingsShell = settingsSurface.Surface
const SkillBrowser = skillsSurface.Surface
const FleetView = machinesSurface.Surface
const AuditLogView = auditSurface.Surface

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



export { providerHandoffChoices, openProviderChoice, forkProviderChoice, type ProviderChoice } from "./provider-choice-dialog.js"

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
  const fleetClientAccess = useSyncExternalStore(accessSession.subscribe, accessSession.snapshot, accessSession.snapshot)
  const admittedMachines = useMemo(() => new Set(Object.entries(fleetClientAccess).filter(([, access]) => access.state === "admitted").map(([id]) => id)), [fleetClientAccess])
  useEffect(() => () => accessSession.clear(), [accessSession])
  useEffect(() => {
    if (home.fleet) accessSession.retain(fleetMachines(home.fleet.entries))
  }, [home.fleet, accessSession])
  const access = attached ? accessSession.access(attached.machineId) : undefined
  const remote = useWorkspace(rpcUrl, clientKind, undefined, undefined,
    access ? { state: "client", admission: access,
      resolveEndpoint: (deadline) => prepareFleetEndpoint({ ...accessInputs.current, ...access, deadline }),
    } : { state: "disabled" }, relayPinStorage)
  const { fleet, fleetOverflow, forgetMachine, pairMachine, listDevices, issueDeviceCode, revokeDevice, rotateDevice, renameDevice } = home
  const homeSkillInventory = home.getSkillInventory
  const {
    activateSession,
    archiveSession,
    authorizeArtifact,
    claimTerminal,
    closeTerminal,
    connected,
    clientAccess: workspaceAccess,
    stateRecovery,
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
  const watching = workspaceAccess === "watching"
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
    previewBuildBasis,
    surface,
    theme,
    windowDecoration,
  } = workspaceUi
  const [activeWindowDecoration, setActiveWindowDecoration] = useState<WorkspaceWindowDecoration>("domovoi")
  useAppearanceTheme(theme)
  const resolvedTheme = resolveAppearanceTheme(theme, colorSchemeQuery()?.matches ?? true)
  const commandPlatform: CommandPalettePlatform = windowBridge?.platform
    ?? (typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "darwin" : "linux")
  const setDockCollapsed = (collapsed: boolean) => {
    const activePanel = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement.closest("[data-workspace-panel]")?.getAttribute("data-workspace-panel")
      : null
    setWorkspaceUi((current) => ({ ...current, dockCollapsed: collapsed }))
    // Closing removes the panel the focused control lived in, so hand focus
    // back to whatever opened it rather than letting it fall to the body.
    const opener = dockOpenerRef.current
    if (collapsed && activePanel === "dock" && opener instanceof HTMLElement) {
      restoreFocusAfterUpdate({ current: opener })
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
    if (watching) return
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
  // Once the shell has painted, the secondary surfaces are fetched while the
  // browser is idle, so opening one rarely shows the loading frame at all.
  useEffect(() => prefetchWhenIdle(lazySurfaces), [])
  // The web reloads the page for a surface whose chunk failed to load; the
  // desktop leaves it unset and loads the chunk again.
  const reloadForNewCode = platform?.code?.reloadForNewCode
  const [dismissedStateRecovery, setDismissedStateRecovery] = useState<string | null>(null)
  const visibleStateRecovery = stateRecovery && stateRecovery.occurredAt !== dismissedStateRecovery
    ? stateRecovery
    : null
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
  // A row picked on another machine (J39) switches this window to that
  // machine, then opens the session once its snapshot arrives.
  const [pendingElsewhere, setPendingElsewhere] = useState<PendingElsewhere | null>(null)
  const windowMachineId = attached?.machineId ?? homeMachineId
  useEffect(() => {
    if (!pendingElsewhere) return
    const step = advancePendingElsewhere(pendingElsewhere, {
      currentMachineId: windowMachineId,
      snapshotMachineId: snapshot?.machine.id ?? null,
      sessionIds: snapshot?.sessions.map((session) => session.id) ?? [],
    })
    if (step.next !== pendingElsewhere) setPendingElsewhere(step.next)
    if (step.open) openSessionInWorkspace(step.open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingElsewhere, windowMachineId, snapshot])
  const searchTargets = windowMachineId ? paletteSearchTargets({
    machines: fleetMachines(fleet?.entries ?? []),
    access: fleetClientAccess,
    homeMachineId,
    currentMachineId: windowMachineId,
    currentLabel: snapshot?.machine.name ?? windowMachineId,
  }) : null
  const homeSearch = home.searchSessions
  const machineSearch = useMemo(() => !searchTargets || searchTargets.others.length === 0 ? undefined : {
    here: searchTargets.here,
    machines: searchTargets.others,
    search: async (machineId: string, query: string, signal: AbortSignal) => {
      if (machineId !== homeMachineId) return accessSession.search(machineId, query, signal)
      const deadline = Deadline.start(10_000)
      try {
        return await homeSearch({ query, limit: 20 }, { deadline, signal })
      } finally {
        deadline.clear()
      }
    },
    open: (machineId: string, sessionId: string) => {
      if (windowMachineId && switchMachine(machineId)) setPendingElsewhere({ from: windowMachineId, machineId, sessionId, reached: false })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(searchTargets), homeMachineId, accessSession, homeSearch, switchMachine])
  const sessionRowAction = (action: SessionRowAction, sessionId: string) => {
    if (watching) return
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
    if (action === "resume") {
      openSessionInWorkspace(sessionId)
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
  // The hold is local and makes the screen look paused, so a pause the daemon
  // refused or never answered is said out loud: its turns are still running.
  const pauseActiveTurns = () => {
    setQueues(holdAllAfterStop)
    setWorkspaceError("")
    void pauseAll().catch((cause: unknown) => {
      setWorkspaceError(`Pause everything failed: ${cause instanceof Error ? cause.message : "the daemon did not confirm the pause"}`)
    })
  }
  const stopEverything = () => {
    void emergencyStop()
  }
  const takeActiveCheckpoint = () => {
    const session = snapshot ? activeSession(snapshot) : undefined
    if (!session) return
    setWorkspaceError("")
    void createCheckpoint(session.id).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "The checkpoint could not be created")
    })
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
    if (watching) return
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
      void sendMessage(session.id, message.text, selection, message.attachments ? [...message.attachments] : undefined)
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
  }, [snapshot, queues, emergencyStopPending, skills, sendMessage, localSkillInventory, settled, watching])
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
    if (watching) return
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
    if (watching || !windowBridge || !activeWorkspacePath || attached) return
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
  const rawWorkspaceCommands = buildWorkspaceCommands({
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
    ...(!watching && snapshot && activeSession(snapshot) ? {
      takeCheckpoint: takeActiveCheckpoint,
      checkpointBlocked: Boolean(activeSession(snapshot)?.activeTurnId),
    } : {}),
    // Cmd+Enter on a machine starts a session there: attach to that daemon,
    // then open the launcher on it. The intent names the machine, and the
    // launcher opens only once that machine's snapshot is the one on screen;
    // a refused or abandoned attachment drops it rather than opening the form
    // on whichever daemon is left.
    ...(!watching ? { startSessionOn: (machineId: string) => {
      if (!switchMachine(machineId)) return
      setLaunchIntent({ machineId })
    } } : {}),
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
  const workspaceCommands = watching
    ? rawWorkspaceCommands.map((command) => watchingMutationCommands.has(command.id) || command.id.startsWith("session-") || command.id.startsWith("move-")
      ? { ...command, disabled: true }
      : command)
    : rawWorkspaceCommands
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
  const machineSurfaces = (pinControl?: ReactNode, pinned?: boolean) => snapshot ? <ArtifactDock pinControl={pinControl} pinned={pinned ?? false} snapshot={snapshot} clientAccess={workspaceAccess} buildBasisId={snapshot.activeSessionId ? previewBuildBasis[snapshot.activeSessionId] : undefined} onBuildBasisChange={(artifactId) => { const sessionId = snapshot.activeSessionId; if (sessionId) setWorkspaceUi((current) => ({ ...current, previewBuildBasis: { ...current.previewBuildBasis, [sessionId]: artifactId } })) }} onCollapse={() => setDockCollapsed(true)} collapseButtonRef={dockCollapseButtonRef} defaultTab={clientKind === "desktop" ? "changes" : "preview"} tab={dockTab} onTabChange={setDockTab} rpcUrl={endpointUrl} authorizeArtifact={authorizeArtifact} connected={connected} terminalControls={terminalControls} onCreateAnnotation={createAnnotation} onLoadSessionHistory={loadSessionHistory} onRevokeApprovalRule={revokeApprovalRule} onLoadHardGates={listHardGates} onRestoreCheckpoint={restoreCheckpointOnce} worktreeName={activeWorkspacePath?.split(/[\\/]/u).at(-1)} onForkCheckpoint={forkFromCheckpoint} onTakeCheckpoint={createCheckpoint} onOpenInEditor={!watching && windowBridge && activeWorkspacePath && !attached ? openActiveWorkspaceInEditor : undefined} restoreBusy={checkpointRestorePending} onLoadSessionEvidence={loadSessionEvidence} onRevertSessionFile={revertSessionFile} onEditPlan={(edit) => editPlan(snapshot.activeSessionId ?? "", edit)} onDiscardPlanEdit={(editId) => discardPlanEdit(snapshot.activeSessionId ?? "", editId)} onCarryOnPlan={() => snapshot.activeSessionId ? sendMessage(snapshot.activeSessionId, "Looks right, carry on") : Promise.reject(new Error("No session is active"))} onReplyToAnnotation={replyToAnnotation} onSetAnnotationStatus={setAnnotationStatus} previewRefusal={clientKind === "desktop" && attached ? "This remote connection supports RPC and Terminal. Preview frames need a separate verified path. Open the target's own app to use its previews." : undefined} {...(windowBridge ? { captureAnnotation: windowBridge.captureAnnotation } : {})} /> : null
  const layoutKey = !dockCollapsed && dockPinned ? "drawer.dock" : "drawer.thread"
  const defaultLayout = layouts[layoutKey]
  const shellTitle = launcherMode
    ? `New session${snapshot?.project ? ` in ${snapshot.project.name}` : ""}`
    : surface === "providers"
      ? "Settings"
      : surface === "skills"
        ? "Skills"
        : surface === "fleet"
          ? "Machines"
          : surface === "audit"
            ? `Audit log${snapshot ? ` on ${snapshot.machine.name}` : ""}`
            : snapshot?.sessions.find((session) => session.id === snapshot.activeSessionId)?.title
  const listedMachines = snapshot
    ? fleetMachines(fleet?.entries ?? [localFleetEntry(snapshot)])
    : []
  const unreachableMachines = listedMachines.filter((machine) => machine.health === "unreachable").length
  const machineAvailability = `${listedMachines.length} ${listedMachines.length === 1 ? "machine" : "machines"} · ${unreachableMachines} unreachable`

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
      if (shouldCollapseDockForWidth(width)) setDockCollapsed(true)
      // No sessions panel to collapse any more: the drawer is already out of
      // the layout, so a narrow window costs it nothing.
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  return (
    <SurfaceCodeReload.Provider value={reloadForNewCode}>
    <TooltipProvider>
      <div ref={shellRef} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <AppBar sessionsDrawer={snapshot ? <SessionsDrawerTrigger snapshot={snapshot} open={sessionsOpen} onOpenChange={setSessionsOpen} /> : undefined} snapshot={snapshot} connected={connected} clientAccess={workspaceAccess} emergencyStopPending={emergencyStopPending} emergencyStopOutcome={emergencyStopOutcome} emergencyStopError={emergencyStopError} bridge={windowBridge} windowDecoration={activeWindowDecoration} onNewSession={() => snapshot?.project ? setLauncherMode("session") : requestOpenProject()} onOpenMachines={() => setSurface("fleet")} onOpenSettings={() => setSurface("providers")} onPauseAll={pauseActiveTurns} onEmergencyStop={stopEverything} onOpenCommands={openCommandPalette} onToggleTheme={() => { if (!watching) setWorkspaceUi((current) => ({ ...current, theme: resolvedTheme === "dark" ? "light" : "dark" })) }} commandShortcut={commandPlatform === "darwin" ? "⌘K" : "Ctrl+K"} title={shellTitle} machineTransport={connected ? attached ? "remote" : "local" : "unreachable"} theme={resolvedTheme} />
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
          <SessionsDrawerColumn
            snapshot={snapshot}
            open={sessionsOpen}
            onActivate={openSessionInWorkspace}
              onAction={watching ? undefined : sessionRowAction}
            machineAvailability={machineAvailability}
            onOpenMachines={() => setSurface("fleet")}
            {...(clientKind === "web" && !attached ? {
              scope: { machine: snapshot.machine.name, note: "this machine only" },
              credentialNote: { label: "Paired for this tab", meta: "ends when it closes" },
            } : {})}
          />
          <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive {snapshot.sessions.find((session) => session.id === archiveTarget)?.title ?? "this session"}?</AlertDialogTitle>
                <AlertDialogDescription>{archiveSessionDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <ArchiveConfirmBody
                worktreePath={snapshot.sessions.find((session) => session.id === archiveTarget)?.workspacePath}
                branch={snapshot.sessions.find((session) => session.id === archiveTarget)?.branch}
              />
              <AlertDialogFooter>
                <AlertDialogCancel>Keep the session</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={watching}
                  onClick={() => {
                    if (watching) return
                    const target = archiveTarget
                    setArchiveTarget(null)
                    if (target) void archiveSession(target).catch((cause: unknown) => setConnectionError(cause instanceof Error ? cause.message : "The session could not be archived"))
                  }}
                >
                  Archive and remove the worktree
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {surface === "providers" ? (
          <SettingsShell
            providers={snapshot.machine.providers}
            secrets={providerSecrets}
            readOnly={watching}
            {...(localDaemon && !attached ? { localDaemon } : {})}
            {...(attached || clientKind !== "desktop" ? {} : {
              pairing: {
                connected: home.connected,
                onIssueCode: issueDeviceCode,
                onCopy: (text: string) => platform ? platform.clipboard.writeText(text) : Promise.reject(new Error("This client has no clipboard")),
                onListDevices: listDevices,
                inAppDaemon: localDaemon?.inApp ?? false,
              },
            })}
            approvalRules={snapshot.approvalRules}
            notifications={notificationPreferences}
            onNotificationsChange={(next: NotificationPreferences) => {
              if (watching) return
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
              if (watching) return
              setWorkspaceUi((current) => ({ ...current, theme: next }))
            }}
            {...(firstRunEnabled ? { onResetFirstRun: resetFirstRun } : {})}
            {...(windowBridge ? {
              externalEditor,
              onExternalEditorChange: (editor: DesktopExternalEditor) => {
                if (watching) return
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
            readOnly={watching}
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
            clientAccess={fleetClientAccess}
            readOnly={watching}
            onAuthorizeClient={(machineId, credential, signal) => accessSession.authorize(machineId, credential, signal)}
            onRemoveClientAccess={removeClientAccess}
            currentMachineId={attached?.machineId ?? snapshot.machine.id}
            devicesMachineLabel={home.snapshot?.machine.name}
            currentSessionCount={activeSessionCount(snapshot)}
            providers={snapshot.machine.providers}
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
            {...(snapshot.activeSessionId ? { onMoveSessionHere: (machineId: string) => {
              setLauncherTransferTargetId(machineId)
              setSurface("workspace")
            } } : {})}
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
              <ResizablePanel id="thread" defaultSize={dockCollapsed ? "100" : "48"} minSize="34"><Thread key={activeThreadKey(snapshot)} snapshot={snapshot} connected={connected} surface={windowBridge ? "desktop" : "web"} clientAccess={workspaceAccess} emergencyStopPending={emergencyStopPending} queued={snapshot.activeSessionId ? queues[snapshot.activeSessionId] : undefined} onQueuedChange={(next) => snapshot.activeSessionId ? setQueues((current) => setQueue(current, snapshot.activeSessionId!, next)) : undefined} failures={failures} onDismissFailure={(id) => setFailures((current) => current.filter((attempt) => attempt.id !== id))} onResolve={resolveApproval} onSetRuntime={(runtime) => snapshot.activeSessionId ? setRuntime(snapshot.activeSessionId, runtime) : Promise.reject(new Error("No session is active"))} onRestartProviderThread={() => snapshot.activeSessionId ? restartProviderThread(snapshot.activeSessionId) : Promise.reject(new Error("No session is active"))} onForkSession={forkSession} onListModels={listModels} onNewSession={() => snapshot.project ? setLauncherMode("session") : requestOpenProject()} onSend={sendMessage} onCheckpoint={createCheckpoint} onRestoreCheckpoint={restoreCheckpointGuarded} restoreBusy={checkpointRestorePending} pendingTransferTargetId={launcherTransferTargetId} onPendingTransferTargetChange={setLauncherTransferTargetId} onPauseSession={pauseSession} onPairMachine={attached ? undefined : pairMachine} fleet={fleet?.entries} transferFleet={attached ? remote.fleet?.entries ?? [] : fleet?.entries} admittedMachines={admittedMachines} currentMachineId={attached?.machineId ?? snapshot.machine.id} onSelectMachine={switchMachine} onTransferSession={transferSession} onPreviewTransfer={previewTransfer} onReleaseSession={releaseSession} usage={activeSessionUsage} usageToday={usageToday} loadLatestTurn={loadLatestTurn} machineMenuRequest={machineMenuRequest} onDiscoverRuntime={discoverRuntime} onEditPlan={editPlan} onDiscardPlanEdit={discardPlanEdit} onOpenPlanPreview={() => openDockTab("plan")} onOpenSheet={() => openDockTab("changes")} onOpenSkills={() => setSurface("skills")} skillNames={Object.fromEntries(skills.map((skill) => [skill.id, skill.name]))} skillCatalog={skills} /></ResizablePanel>
              {!dockCollapsed && dockPinned ? <><ResizableHandle withHandle aria-label="Resize thread and artifact dock" /><ResizablePanel id="dock" defaultSize={280} minSize="24" maxSize="46">{machineSurfaces(<Button ref={dockUnpinButtonRef} variant="ghost" size="icon-sm" className="size-7 flex-none rounded-full bg-accent text-primary" aria-pressed aria-label="Unpin" onClick={() => setDockPinned(false)}><PinIcon className="size-[15px]" /></Button>, true)}</ResizablePanel></> : null}
            </ResizablePanelGroup>
            {!dockCollapsed && !dockPinned ? (
              <MachineSheet
                open
                pinned={false}
                pinButtonRef={sheetPinButtonRef}
                openerRef={dockOpenerRef}
                onClose={() => setDockCollapsed(true)}
                onTogglePin={() => setDockPinned(true)}
                renderPinControl={(control) => machineSurfaces(control)}
              >
                {null}
              </MachineSheet>
            ) : null}
          </div>
          )}
        </div> : (
          <main className="flex min-h-0 flex-1 bg-background">
            <h1 className="sr-only">Connecting to the daemon</h1>
            <ThreadSkeleton reading={readingLabel} />
          </main>
        )}
        {workspaceError || visibleStateRecovery ? (
          <div className="absolute bottom-3 left-3 z-50 flex max-w-sm flex-col gap-2">
            {visibleStateRecovery ? (
              <StateRecoveryNotice
                recovery={visibleStateRecovery}
                onDismiss={() => setDismissedStateRecovery(visibleStateRecovery.occurredAt)}
                className="w-auto shadow-[var(--shadow-md)]"
              />
            ) : null}
            {workspaceError ? (
              <Alert
                variant="destructive"
                className="w-auto shadow-[var(--shadow-md)]"
              >
                <CircleStopIcon />
                <AlertTitle>Workspace action failed</AlertTitle>
                <AlertDescription>{workspaceError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}
        {snapshot && !watching ? <LauncherDialog
          mode={launcherMode}
          {...(launcherProjectNote ? { projectNote: launcherProjectNote } : {})}
          providers={snapshot.machine.providers}
          toolPath={snapshot.machine.toolPath}
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
          recentSessions={snapshot.sessions}
          onResumeSession={(sessionId) => {
            openSessionInWorkspace(sessionId)
            setLauncherMode(null)
          }}
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
          machineSearch={machineSearch}
          {...(firstRunEnabled && !watching ? {
            onOpenFirstRun: () => setDesktopFirstRun((current) => ({ ...current, open: true })),
          } : {})}
        />
        {firstRunEnabled ? (
          <DesktopFirstRunDialog
            open={!watching && desktopFirstRun.open}
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
    </SurfaceCodeReload.Provider>
  )
}
