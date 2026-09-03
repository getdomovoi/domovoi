import { useEffect, useMemo, useRef, useState, type ComponentType } from "react"
import {
  ClipboardIcon,
  CircleStopIcon,
  CpuIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  HistoryIcon,
  MessageSquarePlusIcon,
  PanelTopIcon,
  RefreshCwIcon,
  MessagesSquareIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./components/ui/command"
import type { FleetMachine, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { machineSelection } from "./machine-selection"
import type { WorkspaceSurface } from "./workspace-persistence"
import { desktopExternalActionLabel, type DesktopExternalEditor } from "./desktop-platform"

export type CommandPalettePlatform = "darwin" | "linux" | "win32"

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

export type WorkspaceCommand = {
  id: string
  label: string
  section: CommandSection
  keywords: readonly string[]
  icon?: ComponentType
  shortcut?: string
  detail?: string
  restoreFocus?: boolean
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
  reconnect,
  setSurface,
  sessions,
  machines,
  skills,
  activateSession,
  selectMachine,
  openSkill,
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
  reconnect: () => void
  setSurface: (surface: WorkspaceSurface) => void
  sessions?: readonly WorkspaceSnapshot["sessions"][number][] | undefined
  machines?: readonly FleetMachine[] | null | undefined
  skills?: readonly { id: string; name: string; scope: string }[] | undefined
  activateSession?: ((sessionId: string) => void) | undefined
  selectMachine?: ((machineId: string) => void) | undefined
  openSkill?: ((skillId: string) => void) | undefined
}): WorkspaceCommand[] {
  return [
    { id: "open-project", label: "Open project", section: "Project", keywords: ["folder", "repository"], icon: FolderOpenIcon, restoreFocus: false, run: openProject },
    { id: "new-session", label: "New session", section: "Session", keywords: ["create", "agent"], icon: MessageSquarePlusIcon, disabled: !connected || !hasProject, restoreFocus: false, run: newSession },
    ...(activeWorkspacePath && openInEditor && copyWorktreePath ? [
      { id: "open-in-editor", label: desktopExternalActionLabel(externalEditor ?? "system"), section: "Session" as const, keywords: ["worktree", "file", "external"], icon: ExternalLinkIcon, run: openInEditor },
      { id: "copy-worktree-path", label: "Copy worktree path", section: "Session" as const, keywords: ["clipboard", "folder"], icon: ClipboardIcon, run: copyWorktreePath },
    ] : []),
    { id: "pause-all", label: "Pause all", section: "Session", keywords: ["stop", "emergency"], icon: CircleStopIcon, disabled: !connected || emergencyStopPending, run: pauseAll },
    { id: "surface-workspace", label: "Agent workspace", section: "Navigate", keywords: ["chat", "thread"], icon: PanelTopIcon, run: () => setSurface("workspace") },
    { id: "surface-providers", label: "Provider settings", section: "Navigate", keywords: ["models", "credentials"], icon: SettingsIcon, run: () => setSurface("providers") },
    { id: "surface-skills", label: "Skills", section: "Navigate", keywords: ["capabilities", "agents"], icon: SparklesIcon, run: () => setSurface("skills") },
    { id: "surface-audit", label: "Audit log", section: "Navigate", keywords: ["history", "receipts"], icon: HistoryIcon, run: () => setSurface("audit") },
    ...(connected ? [] : [{ id: "reconnect", label: "Reconnect daemon", section: "Connection" as const, keywords: ["retry", "machine"], icon: RefreshCwIcon, run: reconnect }]),
    // The launcher opens the objects the workspace already holds: a session, a
    // paired machine, a discovered skill. Nothing here fetches anything.
    ...(activateSession ? (sessions ?? []).map((session) => ({
      id: `session-${session.id}`,
      label: session.title,
      section: "Sessions" as const,
      keywords: [session.state, session.runtime.provider, session.runtime.model],
      icon: MessagesSquareIcon,
      detail: session.state,
      run: () => activateSession(session.id),
    })) : []),
    ...(selectMachine ? (machines ?? []).map((machine) => {
      const selection = machineSelection(machine)
      return {
        id: `machine-${machine.id}`,
        label: machine.label,
        section: "Machines" as const,
        keywords: [machine.platform, machine.connection, machine.health],
        icon: CpuIcon,
        detail: machine.self ? "this machine" : machine.connection,
        disabled: !machine.self && !selection.selectable,
        run: () => selectMachine(machine.id),
      }
    }) : []),
    ...(openSkill ? (skills ?? []).map((skill) => ({
      id: `skill-${skill.id}`,
      label: skill.name,
      section: "Skills" as const,
      keywords: [skill.scope, "skill"],
      icon: SparklesIcon,
      detail: skill.scope,
      run: () => openSkill(skill.id),
    })) : []),
  ]
}

export function restoreCommandPaletteFocus(target: { focus(): void } | null): void {
  target?.focus()
}

export function CommandPalette({
  open,
  platform,
  commands,
  onOpenChange,
  restoreFocusTo,
}: {
  open: boolean
  platform: CommandPalettePlatform
  commands: readonly WorkspaceCommand[]
  onOpenChange: (open: boolean) => void
  restoreFocusTo: { focus(): void } | null
}) {
  const [query, setQuery] = useState("")
  const wasOpen = useRef(open)
  const shouldRestoreFocus = useRef(true)
  const ranked = useMemo(() => rankWorkspaceCommands(commands, query), [commands, query])
  const sections = commandSections

  useEffect(() => {
    if (!wasOpen.current && open) shouldRestoreFocus.current = true
    if (wasOpen.current && !open && shouldRestoreFocus.current) {
      queueMicrotask(() => restoreCommandPaletteFocus(restoreFocusTo))
    }
    wasOpen.current = open
  }, [open, restoreFocusTo])

  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setQuery("")
        onOpenChange(nextOpen)
      }}
      title="Domovoi commands"
      description="Navigate Domovoi and run common session actions."
    >
      <Command shouldFilter={false} loop>
        <CommandInput
          autoFocus
          aria-label="Search commands"
          placeholder="Search commands"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          {sections.map((section) => {
            const items = ranked.filter((command) => command.section === section)
            return items.length ? (
              <CommandGroup key={section} heading={section}>
                {items.map((command) => {
                  const Icon = command.icon
                  return (
                    <CommandItem
                      key={command.id}
                      {...(command.disabled === undefined ? {} : { disabled: command.disabled })}
                      value={`${command.label} ${command.keywords.join(" ")}`}
                      onSelect={() => {
                        if (command.disabled) return
                        shouldRestoreFocus.current = command.restoreFocus !== false
                        onOpenChange(false)
                        command.run()
                      }}
                    >
                      {Icon ? <Icon /> : null}
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.detail ? (
                        <span className="shrink-0 font-machine text-[10px] text-faint">{command.detail}</span>
                      ) : null}
                      {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null
          })}
        </CommandList>
        <p className="m-0 border-t px-3 py-2 font-machine text-[9px] text-muted-foreground">
          ↑↓ navigate · Enter run · Escape close · {platform === "darwin" ? "⌘K" : "Ctrl+K"} toggle
        </p>
      </Command>
    </CommandDialog>
  )
}
