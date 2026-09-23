import { useEffect, useState, type ReactNode } from "react"
import {
  MinusIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareIcon,
  SunIcon,
  XIcon,
} from "lucide-react"
import type { ClientAccess, UsageWindow, UsageWindowParams, SystemEmergencyStopResult, WorkspaceSnapshot } from "@getdomovoi/protocol"
import { Button } from "./components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { DomovoiMark } from "./domovoi-mark"
import { StopMenu } from "./stop-menu"
import { usageTodayRefreshDelayMs, usageTodayWindow } from "./session-usage"
import { StatusDot } from "./status-dot"
import { type DesktopWindowBridge, type WorkspaceWindowDecoration } from "./desktop-platform"

function WindowControls({ bridge }: { bridge: DesktopWindowBridge }) {
  if (bridge.platform === "darwin") return null

  return (
    <div className="electron-no-drag ml-1 flex h-full items-center gap-0.5 text-muted-foreground">
      <Button variant="ghost" size="icon-sm" aria-label="Minimize" onClick={bridge.minimize}>
        <MinusIcon className="size-[15px]" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Maximize" onClick={bridge.maximize}>
        <SquareIcon className="size-[13px]" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close" className="hover:bg-destructive hover:text-primary-foreground" onClick={bridge.close}>
        <XIcon className="size-[15px]" />
      </Button>
    </div>
  )
}

export function AppBar({
  snapshot,
  connected,
  clientAccess = "full",
  emergencyStopPending,
  emergencyStopOutcome,
  emergencyStopError,
  bridge,
  windowDecoration = "domovoi",
  onPauseAll,
  onEmergencyStop,
  onOpenCommands,
  onNewSession,
  onOpenMachines,
  onOpenSettings,
  onToggleTheme,
  commandShortcut,
  sessionsDrawer,
  title,
  machineTransport,
  theme = "dark",
}: {
  snapshot: WorkspaceSnapshot | null
  connected: boolean
  clientAccess?: ClientAccess
  emergencyStopPending: boolean
  emergencyStopOutcome: SystemEmergencyStopResult | null
  emergencyStopError: string | null
  bridge?: DesktopWindowBridge | undefined
  windowDecoration?: WorkspaceWindowDecoration | undefined
  onOpenProject?: (() => void) | undefined
  onPauseAll: () => void
  onEmergencyStop: () => void
  onOpenCommands?: (() => void) | undefined
  onNewSession?: (() => void) | undefined
  onOpenMachines?: (() => void) | undefined
  onOpenSettings?: (() => void) | undefined
  onToggleTheme?: (() => void) | undefined
  commandShortcut?: string | undefined
  sessionsDrawer?: ReactNode | undefined
  title?: string | undefined
  machineTransport?: string | undefined
  theme?: "dark" | "light" | undefined
}) {
  const ownsDecoration = Boolean(bridge) && windowDecoration === "domovoi"
  const emergencyStopMessage = emergencyStopError
    ? `Emergency stop failed: ${emergencyStopError}`
    : emergencyStopOutcome
      ? emergencyStopAnnouncement(emergencyStopOutcome)
      : null
  const leadingInset = ownsDecoration ? bridge?.titlebarLeadingInset ?? 0 : 0
  const activeSession = snapshot?.sessions.find((session) => session.id === snapshot.activeSessionId)
  const titleText = title ?? activeSession?.title ?? snapshot?.project?.name ?? "Domovoi"
  const transport = machineTransport ?? (connected ? "local" : "unreachable")
  const watching = clientAccess === "watching"
  const newSessionShortcut = commandShortcut === "Ctrl+K" ? "Ctrl+N" : "⌘N"
  const appearanceLabel = theme === "dark" ? "Light appearance" : "Dark appearance"

  return (
    <TooltipProvider>
      <header
        className="electron-drag flex h-[var(--shell-titlebar)] shrink-0 items-center gap-3 border-b border-border bg-background px-[14px]"
        style={leadingInset > 0 ? { paddingLeft: leadingInset } : undefined}
      >
      <DomovoiMark reduced className="size-5 shrink-0 text-primary" />
      {sessionsDrawer ? <span className="electron-no-drag inline-flex items-center">{sessionsDrawer}</span> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="electron-no-drag size-7 shrink-0" aria-label="New session" disabled={watching || !onNewSession} onClick={onNewSession}>
            <PlusIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">New session · {newSessionShortcut}</TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 flex-1 justify-center">
        <Button
          variant="outline"
          className="electron-no-drag h-7 w-full max-w-[560px] min-w-0 justify-start rounded-full bg-sidebar px-3 font-normal hover:bg-accent"
          aria-label="Open command palette"
          disabled={!onOpenCommands}
          onClick={onOpenCommands}
        >
          <SearchIcon className="size-3.5 shrink-0 text-faint" />
          <span className="truncate text-[12.5px] text-strong">{titleText}</span>
          <span className="flex-1" />
          {commandShortcut ? <kbd className="shrink-0 font-machine text-[10.5px] text-faint">{commandShortcut}</kbd> : null}
        </Button>
      </div>
      {watching ? (
        <div className="electron-no-drag flex h-7 shrink-0 items-center gap-2 rounded-full border border-info-border bg-info-background px-2.5 text-[11px] text-info-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-info" />
          watching only
        </div>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="electron-no-drag h-7 shrink-0 rounded-full px-2.5 font-normal"
        aria-label={`Machines: ${snapshot?.machine.name ?? "daemon"}`}
        disabled={!onOpenMachines}
        onClick={onOpenMachines}
      >
        <StatusDot meaning={connected ? "online" : "offline"} label={`${connected ? "Connected to" : "Disconnected from"} ${snapshot?.machine.name ?? "daemon"}.`} size="inline" labelHidden />
        <span className="font-machine text-[10.5px]">{snapshot?.machine.name ?? "daemon"}</span>
        <span className="text-[10.5px] text-faint">{transport}</span>
      </Button>
      <StopMenu connected={connected} pending={emergencyStopPending} disabled={watching} onPauseAll={onPauseAll} onEmergencyStop={onEmergencyStop} />
      <Button variant="ghost" size="icon-sm" className="electron-no-drag size-7 shrink-0" aria-label="Settings" disabled={!onOpenSettings} onClick={onOpenSettings}>
        <SettingsIcon className="size-4" />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="electron-no-drag size-7 shrink-0" aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"} disabled={watching || !onToggleTheme} onClick={onToggleTheme}>
            {theme === "dark" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{appearanceLabel}</TooltipContent>
      </Tooltip>
      {emergencyStopMessage ? (
        <span role={emergencyStopError ? "alert" : "status"} aria-live={emergencyStopError ? "assertive" : "polite"} className="sr-only">
          {emergencyStopMessage}
        </span>
      ) : null}
      {ownsDecoration && bridge ? <WindowControls bridge={bridge} /> : null}
      </header>
    </TooltipProvider>
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
    outcomeCount(outcomes.mutationsCancelled, "mutation cancelled", "mutations cancelled"),
    outcomeCount(outcomes.providersReset, "provider reset", "providers reset"),
  ]
  if (result.failures.length > 0) summary.push(outcomeCount(result.failures.length, "failure", "failures"))
  return `Emergency stop complete: ${summary.join(", ")}.`
}
