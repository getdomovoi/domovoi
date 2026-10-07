import type { ComponentType } from "react"
import {
  ClipboardIcon,
  CircleStopIcon,
  CpuIcon,
  DiffIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GitCommitHorizontalIcon,
  HistoryIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  PanelTopIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ServerIcon,
  MessagesSquareIcon,
  SettingsIcon,
  ShieldIcon,
  SmartphoneIcon,
  SparklesIcon,
} from "lucide-react"

import type { FleetEntry, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { fleetMachines, transferTargets } from "./fleet-entries"
import type { StatusMeaning } from "./status-dot"
import { machineAttachment } from "./machine-selection"
import type { WorkspaceSurface } from "./workspace-persistence"
import { desktopExternalActionLabel, type DesktopExternalEditor } from "./desktop-platform"

// The commands and shortcuts the shell binds at startup. The palette that
// draws them (command-palette.tsx) loads the first time it opens, so what the
// shell needs before then lives here.

export type CommandPalettePlatform = "darwin" | "linux" | "win32"

// The palette's accessible name, which the dialog standing in for it while
// its code loads carries too.
export const commandPaletteTitle = "Domovoi commands"

type ShortcutEvent = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export const commandSections = [
  "Project",
  "Session",
  "Sessions",
  "Machines",
  "Skills",
  "Navigate",
  "Connection",
] as const

export type CommandSection = typeof commandSections[number]

// The dot repeats what the meta line says in words, which is the rule here:
// colour is never the only carrier of a meaning.
export type EntityKind = "PROJECT" | "SESSION" | "MACHINE" | "SKILL"

export type WorkspaceCommand = {
  id: string
  label: string
  section: CommandSection
  keywords: readonly string[]
  icon?: ComponentType
  // The design's spec, such as "mod+shift+D". The palette draws it for the
  // platform with shortcutLabel, and the shell binds it.
  shortcut?: string
  detail?: string | undefined
  // An entity row, rather than a verb. The launcher lists the things the
  // workspace holds beside the actions it can take, and a person should be able
  // to tell which is which without reading the label.
  meta?: string | undefined
  kind?: EntityKind | undefined
  // What Cmd+Enter does on this row. Plain Enter opens a thing where it already
  // is; this chooses where it runs instead, so only a row with somewhere else
  // to go carries it.
  openElsewhere?: (() => void) | undefined
  // Where this row can go. A machine acts at once; a live session has to be
  // told which machine, so it carries the choice instead of an action.
  elsewhereTargets?: readonly WorkspaceCommand[] | undefined
  tone?: StatusMeaning | undefined
  restoreFocus?: boolean
  // Whether this row opens a session start. Its item is registered with
  // startOpenerRef, as Domovoi's other start controls are (ruling Q410).
  opensStart?: boolean
  disabled?: boolean
  run: () => void
}

export function commandPaletteShortcut(
  event: ShortcutEvent,
  platform: CommandPalettePlatform,
): boolean {
  if (event.key.toLowerCase() !== "k" || event.altKey) return false
  return platform === "darwin"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

// The two shortcuts Desktop V2's palette names beside its commands: the
// changes sheet and every machine. Shift keeps them clear of the editing keys.
export type WorkspaceShortcut = "changes" | "machines"

export function workspaceShortcut(
  event: ShortcutEvent & { shiftKey: boolean },
  platform: CommandPalettePlatform,
): WorkspaceShortcut | null {
  if (!event.shiftKey || event.altKey) return null
  const modifier = platform === "darwin"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if (!modifier) return null
  const key = event.key.toLowerCase()
  return key === "d" ? "changes" : key === "m" ? "machines" : null
}

// A shortcut is held as the design's spec ("mod+shift+D") and drawn for the
// platform the way the design's K() draws it: symbols run together on macOS,
// names joined by "+" elsewhere.
export function shortcutLabel(spec: string, platform: CommandPalettePlatform): string {
  const mac = platform === "darwin"
  const parts = spec.split("+").map((part) => {
    if (part === "mod") return mac ? "⌘" : "Ctrl"
    if (part === "shift") return mac ? "⇧" : "Shift"
    if (part === "alt") return mac ? "⌥" : "Alt"
    return part
  })
  return mac ? parts.join("") : parts.join("+")
}

function commandScore(command: WorkspaceCommand, query: string): number {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return 0
  const label = command.label.toLocaleLowerCase()
  if (label === normalized) return 5
  if (label.startsWith(normalized)) return 4
  if (label.split(/\s+/u).some((word) => word.startsWith(normalized))) return 3
  if (command.keywords.some((keyword) => keyword.toLocaleLowerCase().startsWith(normalized))) return 2
  if (`${label} ${command.keywords.join(" ")}`.toLocaleLowerCase().includes(normalized)) return 1
  return -1
}

export function rankWorkspaceCommands(
  commands: readonly WorkspaceCommand[],
  query: string,
): WorkspaceCommand[] {
  return commands
    .map((command, index) => ({ command, index, score: commandScore(command, query) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ command }) => command)
}

export function buildWorkspaceCommands({
  activeWorkspacePath,
  copyWorktreePath,
  connected,
  emergencyStopPending,
  hasProject,
  openProject,
  newSession,
  openInEditor,
  externalEditor,
  pauseAll,
  emergencyStop,
  reconnect,
  setSurface,
  sessions,
  entries,
  admittedMachines,
  skills,
  activateSession,
  selectMachine,
  openSkill,
  startSessionOn,
  openCheckpoints,
  takeCheckpoint,
  checkpointBlocked,
  previewTransferTo,
  currentMachineId,
  transferEntries,
  openChanges,
  revertToCheckpoint,
  reviewRules,
  approvalRuleCount,
  moveSession,
  pairDevice,
  shortcutsBound,
}: {
  activeWorkspacePath?: string | undefined
  copyWorktreePath?: (() => void) | undefined
  connected: boolean
  emergencyStopPending: boolean
  hasProject: boolean
  openProject: () => void
  newSession: () => void
  openInEditor?: (() => void) | undefined
  externalEditor?: DesktopExternalEditor | undefined
  pauseAll: () => void
  emergencyStop: () => void
  reconnect: () => void
  setSurface: (surface: WorkspaceSurface) => void
  sessions?: readonly WorkspaceSnapshot["sessions"][number][] | undefined
  entries?: readonly FleetEntry[] | null | undefined
  admittedMachines?: ReadonlySet<string> | undefined
  skills?: readonly { id: string; name: string; scope: string }[] | undefined
  activateSession?: ((sessionId: string) => void) | undefined
  selectMachine?: ((machineId: string) => void) | undefined
  openSkill?: ((skillId: string) => void) | undefined
  // Cmd+Enter on a live session is a move, and a move is never performed from
  // here: choosing a machine opens the transfer preflight and the existing
  // consent surface takes the decision.
  previewTransferTo?: ((sessionId: string, machineId: string) => void) | undefined
  currentMachineId?: string | undefined
  transferEntries?: readonly FleetEntry[] | undefined
  // Cmd+Enter on a machine starts a session there. Nothing to reconcile.
  startSessionOn?: ((machineId: string) => void) | undefined
  // Checkpoints is a view of the History pane, not a pane of its own, so the
  // command opens History already narrowed to that one category.
  openCheckpoints?: (() => void) | undefined
  // The daemon refuses a checkpoint while a turn is running, so the command is
  // locked for that time rather than offered and then refused.
  takeCheckpoint?: (() => void) | undefined
  checkpointBlocked?: boolean | undefined
  // Desktop V2's session commands. Each opens a view that already exists and
  // decides nothing itself: the sheet tab, the machine menu or the settings
  // card takes it from there. A shell that cannot open one leaves it out.
  openChanges?: (() => void) | undefined
  // The checkpoint count the design draws ("5 available") is not here: the
  // snapshot does not carry it and the palette fetches nothing.
  revertToCheckpoint?: (() => void) | undefined
  reviewRules?: (() => void) | undefined
  approvalRuleCount?: number | undefined
  moveSession?: (() => void) | undefined
  pairDevice?: (() => void) | undefined
  // Whether the shell binds the changes and machines shortcuts. Ruling Q291 A
  // (2026-10-01): only the desktop does, so a browser names no shortcut it
  // would leave to the browser.
  shortcutsBound?: boolean | undefined
}): WorkspaceCommand[] {
  // Desktop V2's COMMANDS lead in the design's order, each with the colour its
  // dot is drawn in (ruling Q375 A); the commands the design does not draw
  // follow them (ruling Q376 A) and take the same colours by the same reading:
  // green opens a screen, blue opens a sheet, a flow or another app, amber can
  // undo work, red stops it. With an empty query the palette keeps this order.
  return [
    ...(openChanges ? [
      { id: "open-changes", label: "Open the changes sheet", section: "Session" as const, keywords: ["diff", "files", "review"], icon: DiffIcon, tone: "handoff" as const, ...(shortcutsBound ? { shortcut: "mod+shift+D" } : {}), run: openChanges },
    ] : []),
    ...(takeCheckpoint ? [
      { id: "take-checkpoint", label: "Take a checkpoint", section: "Session" as const, keywords: ["checkpoint", "save", "commit", "snapshot"], icon: GitCommitHorizontalIcon, tone: "online" as const, detail: "manual", disabled: !connected || Boolean(checkpointBlocked), run: takeCheckpoint },
    ] : []),
    ...(revertToCheckpoint ? [
      { id: "revert-checkpoint", label: "Revert to a checkpoint", section: "Session" as const, keywords: ["restore", "rewind", "undo"], icon: RotateCcwIcon, tone: "waiting" as const, run: revertToCheckpoint },
    ] : []),
    ...(reviewRules ? [
      { id: "review-rules", label: "Review what you have allowed", section: "Session" as const, keywords: ["rules", "approvals", "permissions"], icon: ShieldIcon, tone: "handoff" as const, detail: `${approvalRuleCount ?? 0} ${approvalRuleCount === 1 ? "rule" : "rules"}`, run: reviewRules },
    ] : []),
    // The machine menu takes the choice of machine and the transfer dialog the
    // decision, so the palette only opens the menu. Focus goes with it.
    ...(moveSession ? [
      { id: "move-session", label: "Move this session to another machine", section: "Session" as const, keywords: ["transfer", "machine"], icon: MonitorIcon, tone: "handoff" as const, detail: "handoff", disabled: !connected, restoreFocus: false, run: moveSession },
    ] : []),
    { id: "surface-fleet", label: "Show all machines", section: "Navigate", keywords: ["fleet", "machines", "devices", "pairing"], icon: ServerIcon, tone: "online", ...(shortcutsBound ? { shortcut: "mod+shift+M" } : {}), run: () => setSurface("fleet") },
    ...(pairDevice ? [
      { id: "pair-device", label: "Pair a phone or tablet", section: "Navigate" as const, keywords: ["pairing", "phone", "tablet", "device"], icon: SmartphoneIcon, tone: "handoff" as const, detail: "settings", disabled: !connected, run: pairDevice },
    ] : []),
    { id: "surface-audit", label: "Read the audit log", section: "Navigate", keywords: ["audit log", "history", "receipts"], icon: HistoryIcon, tone: "online", detail: "on this machine", run: () => setSurface("audit") },
    { id: "open-project", label: "Open project", section: "Project", keywords: ["folder", "repository"], icon: FolderOpenIcon, tone: "handoff", restoreFocus: false, run: openProject },
    { id: "new-session", label: "New session", section: "Session", keywords: ["create", "agent"], icon: MessageSquarePlusIcon, tone: "handoff", disabled: !connected || !hasProject, restoreFocus: false, opensStart: true, run: newSession },
    ...(activeWorkspacePath && openInEditor ? [
      { id: "open-in-editor", label: desktopExternalActionLabel(externalEditor ?? "system"), section: "Session" as const, keywords: ["worktree", "file", "external"], icon: ExternalLinkIcon, tone: "handoff" as const, run: openInEditor },
    ] : []),
    ...(activeWorkspacePath && copyWorktreePath ? [
      { id: "copy-worktree-path", label: "Copy worktree path", section: "Session" as const, keywords: ["clipboard", "folder"], icon: ClipboardIcon, tone: "handoff" as const, run: copyWorktreePath },
    ] : []),
    { id: "pause-all", label: "Pause everything", section: "Session", keywords: ["pause", "turn boundary"], icon: CircleStopIcon, tone: "waiting", disabled: !connected || emergencyStopPending, run: pauseAll },
    { id: "emergency-stop", label: "Emergency stop", section: "Session", keywords: ["kill", "stop", "emergency"], icon: CircleStopIcon, tone: "offline", disabled: !connected || emergencyStopPending, run: emergencyStop },
    { id: "surface-workspace", label: "Agent workspace", section: "Navigate", keywords: ["chat", "thread"], icon: PanelTopIcon, tone: "online", run: () => setSurface("workspace") },
    { id: "surface-providers", label: "Provider settings", section: "Navigate", keywords: ["models", "credentials"], icon: SettingsIcon, tone: "online", run: () => setSurface("providers") },
    { id: "surface-skills", label: "Skills", section: "Navigate", keywords: ["capabilities", "agents"], icon: SparklesIcon, tone: "online", run: () => setSurface("skills") },
    ...(openCheckpoints ? [
      { id: "open-checkpoints", label: "Checkpoints", section: "Navigate" as const, keywords: ["restore", "rewind", "worktree", "history"], icon: RotateCcwIcon, tone: "handoff" as const, run: openCheckpoints },
    ] : []),
    ...(connected ? [] : [{ id: "reconnect", label: "Reconnect daemon", section: "Connection" as const, keywords: ["retry", "machine"], icon: RefreshCwIcon, tone: "handoff" as const, run: reconnect }]),
    // The launcher opens the objects the workspace already holds: a session, a
    // paired machine, a discovered skill. Nothing here fetches anything.
    ...(activateSession ? (sessions ?? []).map((session): WorkspaceCommand => ({
      id: `session-${session.id}`,
      label: session.title,
      section: "Sessions" as const,
      keywords: [session.state, session.runtime.provider, session.runtime.model],
      icon: MessagesSquareIcon,
      detail: session.state,
      meta: `${session.runtime.provider} · ${session.state}`,
      kind: "SESSION" as const,
      tone: sessionTone(session.state),
      ...(previewTransferTo && currentMachineId ? {
        elsewhereTargets: transferTargets({ entries: entries ?? [], transferEntries, currentMachineId })
          .map((target): WorkspaceCommand => ({
            id: `move-${session.id}-to-${target.id}`,
            label: target.label,
            section: "Machines" as const,
            keywords: [target.platform, target.connection],
            meta: `${target.platform} · ${target.connection}`,
            kind: "MACHINE" as const,
            tone: "online" as const,
            run: () => previewTransferTo(session.id, target.id),
          })),
      } : {}),
      run: () => activateSession(session.id),
    })) : []),
    // Only a machine entry can be selected. A pending or unenrolled entry has
    // nothing to attach to, so the palette does not list it.
    ...(selectMachine ? fleetMachines(entries ?? []).map((machine): WorkspaceCommand => {
      const selection = machineAttachment(machine, admittedMachines?.has(machine.id))
      return {
        id: `machine-${machine.id}`,
        label: machine.label,
        section: "Machines" as const,
        keywords: [machine.platform, machine.connection, machine.health],
        icon: CpuIcon,
        detail: machine.self ? "this machine" : machine.connection,
        meta: `${machine.platform} · ${machine.self ? "this machine" : machine.connection}`,
        kind: "MACHINE" as const,
        tone: selection.selectable ? "online" : "offline",
        ...(startSessionOn && selection.selectable && !machine.self ? { openElsewhere: () => startSessionOn(machine.id) } : {}),
        disabled: !selection.selectable,
        run: () => selectMachine(machine.id),
      }
    }) : []),
    ...(openSkill ? (skills ?? []).map((skill): WorkspaceCommand => ({
      id: `skill-${skill.id}`,
      label: skill.name,
      section: "Skills" as const,
      keywords: [skill.scope, "skill"],
      icon: SparklesIcon,
      detail: skill.scope,
      meta: `${skill.scope} skill`,
      kind: "SKILL" as const,
      tone: "handoff",
      run: () => openSkill(skill.id),
    })) : []),
  ]
}

// The launcher shows state without reaching for the grouping logic the drawer
// uses: it has one session at a time and no approvals in hand, so it reads the
// state the snapshot already carries.
// A status dot shows a state, never an event. A transfer is something that
// happened to a session, not a condition it is in: after it completes the
// session is running, idle or waiting on a gate, on the new machine. The test
// that settles it is a session that moved and then raised a gate — it cannot be
// both handoff-blue and gate-amber, and the gate is obviously the answer, which
// means handoff was never a state, just a recent event wearing one's clothes.
// Same error as calling provider handoffs "Transfers" in the filter list. A move
// belongs in History, where events live.
export function sessionTone(state: WorkspaceSnapshot["sessions"][number]["state"]): StatusMeaning {
  if (state === "failed" || state === "ownership-conflict") return "offline"
  if (state === "waiting" || state === "archiving" || state === "transferring") return "waiting"
  if (state === "active") return "online"
  return "idle"
}

// Cmd on darwin, Ctrl elsewhere, matching the palette's own toggle.
export function opensElsewhere(event: { key: string; metaKey: boolean; ctrlKey: boolean }, platform: string): boolean {
  return event.key === "Enter" && (platform === "darwin" ? event.metaKey : event.ctrlKey)
}
