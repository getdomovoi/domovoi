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
  RotateCcwIcon,
  ServerIcon,
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
import type { FleetEntry, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { fleetMachines, transferTargets } from "./fleet-entries"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { machineAttachment } from "./machine-selection"
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

// The dot repeats what the meta line says in words, which is the rule here:
// colour is never the only carrier of a meaning.
export type EntityKind = "PROJECT" | "SESSION" | "MACHINE" | "SKILL"

export type WorkspaceCommand = {
  id: string
  label: string
  section: CommandSection
  keywords: readonly string[]
  icon?: ComponentType
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
  entries,
  admittedMachines,
  skills,
  activateSession,
  selectMachine,
  openSkill,
  startSessionOn,
  openCheckpoints,
  previewTransferTo,
  currentMachineId,
  transferEntries,
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
}): WorkspaceCommand[] {
  return [
    { id: "open-project", label: "Open project", section: "Project", keywords: ["folder", "repository"], icon: FolderOpenIcon, restoreFocus: false, run: openProject },
    { id: "new-session", label: "New session", section: "Session", keywords: ["create", "agent"], icon: MessageSquarePlusIcon, disabled: !connected || !hasProject, restoreFocus: false, run: newSession },
    ...(activeWorkspacePath && openInEditor ? [
      { id: "open-in-editor", label: desktopExternalActionLabel(externalEditor ?? "system"), section: "Session" as const, keywords: ["worktree", "file", "external"], icon: ExternalLinkIcon, run: openInEditor },
    ] : []),
    ...(activeWorkspacePath && copyWorktreePath ? [
      { id: "copy-worktree-path", label: "Copy worktree path", section: "Session" as const, keywords: ["clipboard", "folder"], icon: ClipboardIcon, run: copyWorktreePath },
    ] : []),
    { id: "pause-all", label: "Pause all", section: "Session", keywords: ["stop", "emergency"], icon: CircleStopIcon, disabled: !connected || emergencyStopPending, run: pauseAll },
    { id: "surface-workspace", label: "Agent workspace", section: "Navigate", keywords: ["chat", "thread"], icon: PanelTopIcon, run: () => setSurface("workspace") },
    { id: "surface-providers", label: "Provider settings", section: "Navigate", keywords: ["models", "credentials"], icon: SettingsIcon, run: () => setSurface("providers") },
    { id: "surface-skills", label: "Skills", section: "Navigate", keywords: ["capabilities", "agents"], icon: SparklesIcon, run: () => setSurface("skills") },
    { id: "surface-fleet", label: "Fleet", section: "Navigate", keywords: ["machines", "devices", "pairing"], icon: ServerIcon, run: () => setSurface("fleet") },
    { id: "surface-audit", label: "Audit log", section: "Navigate", keywords: ["history", "receipts"], icon: HistoryIcon, run: () => setSurface("audit") },
    ...(openCheckpoints ? [
      { id: "open-checkpoints", label: "Checkpoints", section: "Navigate" as const, keywords: ["restore", "rewind", "worktree", "history"], icon: RotateCcwIcon, run: openCheckpoints },
    ] : []),
    ...(connected ? [] : [{ id: "reconnect", label: "Reconnect daemon", section: "Connection" as const, keywords: ["retry", "machine"], icon: RefreshCwIcon, run: reconnect }]),
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

// A session with somewhere to go. An empty target list is a session that
// cannot move, and offering it a picker with nothing in it says otherwise.
function canChooseMachine(command: WorkspaceCommand): boolean {
  return (command.elsewhereTargets?.length ?? 0) > 0
}

export function restoreCommandPaletteFocus(target: { focus(): void } | null): void {
  target?.focus()
}

export function CommandPalette({
  open,
  platform,
  commands,
  onOpenChange,
  onOpenFirstRun,
  restoreFocusTo,
}: {
  open: boolean
  platform: CommandPalettePlatform
  commands: readonly WorkspaceCommand[]
  onOpenChange: (open: boolean) => void
  restoreFocusTo: { focus(): void } | null
  // Setting a machine up is not a command: it is the thing you reach for when
  // no command here can help yet.
  onOpenFirstRun?: (() => void) | undefined
}) {
  const [query, setQuery] = useState("")
  // cmdk reports the highlighted row by its value, and the value is the command
  // id, so the footer can say what the modified key would do on this row rather
  // than advertising it everywhere and doing nothing on most rows.
  const [highlighted, setHighlighted] = useState("")
  const wasOpen = useRef(open)
  const shouldRestoreFocus = useRef(true)
  const ranked = useMemo(() => rankWorkspaceCommands(commands, query), [commands, query])
  // cmdk highlights the first row on open and only tells us once the selection
  // moves, so an empty report means the first row.
  // While a session is choosing a machine, the list is that session's targets.
  // The session is held by id and looked up in the commands of this render, so
  // a target the list no longer offers cannot run, and a session that has left
  // the list takes the picker with it.
  const [choosingId, setChoosingId] = useState<string | null>(null)
  const choosing = choosingId === null
    ? null
    : commands.find((command) => command.id === choosingId && canChooseMachine(command)) ?? null
  const targets = useMemo(
    () => (choosing ? rankWorkspaceCommands(choosing.elsewhereTargets!, query) : null),
    [choosing, query],
  )
  const rows = targets ?? ranked
  const current = highlighted || rows[0]?.id
  const elsewhere = rows.find((command) => command.id === current
    && (command.openElsewhere || canChooseMachine(command))
    && !command.disabled)
  const sections = commandSections
  const reset = () => { setQuery(""); setChoosingId(null); setHighlighted("") }
  // Every way out closes the same way: nothing chosen and nothing typed is
  // left behind for the next open, whichever side asked for the close.
  const close = () => { reset(); onOpenChange(false) }

  useEffect(() => {
    if (choosingId !== null && choosing === null) reset()
  }, [choosingId, choosing])

  useEffect(() => {
    if (!wasOpen.current && open) shouldRestoreFocus.current = true
    if (wasOpen.current && !open) {
      reset()
      if (shouldRestoreFocus.current) queueMicrotask(() => restoreCommandPaletteFocus(restoreFocusTo))
    }
    wasOpen.current = open
  }, [open, restoreFocusTo])

  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Escape backs out of a half-made choice before it closes the whole
        // launcher. The dialog owns the key, so the step back happens here.
        if (!nextOpen && choosing) {
          reset()
          return
        }
        if (!nextOpen) { close(); return }
        onOpenChange(nextOpen)
      }}
      title="Domovoi commands"
      description="Navigate Domovoi and run common session actions."
    >
      <Command
        shouldFilter={false}
        loop
        value={current ?? ""}
        onValueChange={setHighlighted}
        onKeyDown={(event) => {
          // cmdk's own Enter handler carries no modifiers, so the modified key
          // is read here and stopped before it reaches the default.
          if (!opensElsewhere(event, platform)) return
          // The modified key never falls through to the plain action. Running
          // Enter's job because this row cannot go elsewhere would be a worse
          // answer than doing nothing, and the footer already says which it is.
          event.preventDefault()
          if (!elsewhere) return
          if (canChooseMachine(elsewhere)) {
            // The launcher picks the machine. The preflight takes the decision.
            setChoosingId(elsewhere.id)
            setQuery("")
            setHighlighted("")
            return
          }
          shouldRestoreFocus.current = elsewhere.restoreFocus !== false
          close()
          elsewhere.openElsewhere!()
        }}
      >
        <CommandInput
          autoFocus
          aria-label="Search commands"
          placeholder="Search commands"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          {(choosing ? ["Machines" as const] : sections).map((section) => {
            const items = rows.filter((command) => choosing ? true : command.section === section)
            return items.length ? (
              <CommandGroup key={section} heading={section}>
                {items.map((command) => {
                  const Icon = command.icon
                  return (
                    <CommandItem
                      key={command.id}
                      {...(command.disabled === undefined ? {} : { disabled: command.disabled })}
                      value={command.id}
                      onSelect={() => {
                        if (command.disabled) return
                        shouldRestoreFocus.current = command.restoreFocus !== false
                        close()
                        command.run()
                      }}
                    >
                      {command.kind ? (
                        <StatusDot
                          meaning={command.tone ?? "idle"}
                          label={`${command.kind.toLowerCase()}, ${command.tone ?? "idle"}`}
                          size="default"
                          labelHidden
                          data-testid="entity-dot"
                          className="shrink-0"
                        />
                      ) : Icon ? <Icon /> : null}
                      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <span className="truncate">{command.label}</span>
                        {command.meta ? (
                          <span className="truncate font-machine text-mono-xs text-muted-foreground">{command.meta}</span>
                        ) : null}
                      </span>
                      {command.detail && !command.kind ? (
                        <span className="shrink-0 font-machine text-[10px] text-faint">{command.detail}</span>
                      ) : null}
                      {command.kind ? (
                        <span className="shrink-0 text-eyebrow text-faint">{command.kind}</span>
                      ) : null}
                      {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null
          })}
        </CommandList>
        <div className="flex items-center gap-3 border-t px-3 py-2">
        <p data-testid="palette-hints" className="m-0 flex-1 font-machine text-mono-xs text-muted-foreground">
          {choosing
            ? `↑↓ navigate · Enter move ${choosing.label} here · Escape back`
            : `↑↓ navigate · Enter run${elsewhere ? ` · ${platform === "darwin" ? "⌘" : "Ctrl"}+Enter open elsewhere` : ""} · Escape close · ${platform === "darwin" ? "⌘K" : "Ctrl+K"} toggle`}
        </p>
        {onOpenFirstRun && !choosing ? (
          <button
            type="button"
            className="shrink-0 text-[11px] text-primary"
            onClick={() => {
              shouldRestoreFocus.current = false
              close()
              onOpenFirstRun()
            }}
          >
            First-run setup
          </button>
        ) : null}
        </div>
      </Command>
    </CommandDialog>
  )
}
