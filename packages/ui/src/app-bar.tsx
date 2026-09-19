import { useEffect, useState, type ReactNode } from "react"
import {
  ChevronDownIcon,
  MinusIcon,
  SearchIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import type { UsageWindow, UsageWindowParams, SystemEmergencyStopResult, WorkspaceSnapshot } from "@getdomovoi/protocol"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Separator } from "./components/ui/separator"
import { DomovoiMark } from "./domovoi-mark"
import { StopMenu } from "./stop-menu"
import { usageTodayRefreshDelayMs, usageTodayWindow } from "./session-usage"
import { StatusDot } from "./status-dot"
import { type DesktopWindowBridge, type WorkspaceWindowDecoration } from "./desktop-platform"

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
  // Under the Domovoi frame on macOS the OS draws its buttons over the bar
  // and content starts at the window edge; the desktop says how far past the
  // buttons that is, derived from where it put them.
  const leadingInset = ownsDecoration ? bridge?.titlebarLeadingInset ?? 0 : 0
  return (
    <header
      className="electron-drag flex h-[var(--shell-titlebar)] shrink-0 items-center border-b bg-sidebar px-3"
      style={leadingInset > 0 ? { paddingLeft: leadingInset } : undefined}
    >
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
