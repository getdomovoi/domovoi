import type { ReactNode } from "react"
import type { FleetEntry, FleetHealth, FleetMachine } from "@getdomovoi/protocol"

import {
  fleetMachines,
  pendingOperationNote,
  pendingOperationWord,
  shortMachineId,
  unenrolledNote,
} from "./fleet-entries.js"
import { machineAttachment, machineSelection } from "./machine-selection.js"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"

// Health answers "can I use this machine, and what would fix it", so it is
// shown instead of the raw heartbeat wherever the two disagree.
const healthLabel: Record<FleetHealth, string> = {
  healthy: "Online",
  reconnecting: "Reconnecting",
  degraded: "Not responding",
  unreachable: "UNREACHABLE",
  "version-mismatch": "Version mismatch",
  "upgrade-required": "Upgrade required",
  "pairing-required": "Pair again",
  "credential-store-unavailable": "Keychain unavailable",
}

function sessionSummary(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`
}

function MachineItem({
  machine,
  onSelectMachine,
}: {
  machine: FleetMachine
  onSelectMachine: ((machineId: string) => void) | undefined
}) {
  // Attaching is a client dial, which needs a credential nothing issues yet, so
  // the refusal is stated ahead of health: health can recover, this cannot.
  const attachment = machineAttachment(machine)
  const selectable = attachment.selectable && Boolean(onSelectMachine)
  return (
    <DropdownMenuItem
      disabled={!selectable}
      className="flex-col items-start gap-0.5"
      {...(selectable && onSelectMachine
        ? { onSelect: () => onSelectMachine(machine.id) }
        : {})}
    >
      <span className="font-medium text-strong">{machine.label}</span>
      <span className="font-machine text-[10px] text-faint">
        {machine.connection} · {healthLabel[machine.health]}
        {attachment.selectable ? "" : ` · ${attachment.reason}`}
      </span>
    </DropdownMenuItem>
  )
}

// One row shape per lifecycle kind. Each case returns, so a kind the protocol
// adds later fails to compile here instead of rendering nothing.
function entryItem(
  entry: FleetEntry,
  onSelectMachine: ((machineId: string) => void) | undefined,
): ReactNode {
  switch (entry.kind) {
    case "machine":
      return <MachineItem key={entry.machine.id} machine={entry.machine} onSelectMachine={onSelectMachine} />
    case "pending":
      return (
        <DropdownMenuItem key={entry.machineId} disabled className="flex-col items-start gap-0.5">
          <span className="font-medium text-strong">
            {pendingOperationWord[entry.operation]} {shortMachineId(entry.machineId)}
          </span>
          <span className="font-machine text-[10px] text-faint">{pendingOperationNote}</span>
        </DropdownMenuItem>
      )
    case "unenrolled":
      return (
        <DropdownMenuItem key={entry.machineId} disabled className="flex-col items-start gap-0.5">
          <span className="font-medium text-strong">Never enrolled {shortMachineId(entry.machineId)}</span>
          <span className="font-machine text-[10px] text-faint">{unenrolledNote}</span>
        </DropdownMenuItem>
      )
  }
}

export function MachineSwitcher({
  entries,
  currentMachineId,
  currentSessionCount,
  onPairMachine,
  onSelectMachine,
  onTransferSession,
}: {
  entries: FleetEntry[]
  currentMachineId: string
  currentSessionCount: number
  onPairMachine?: (() => void) | undefined
  onSelectMachine?: ((machineId: string) => void) | undefined
  onTransferSession?: ((machineId: string) => void) | undefined
}) {
  const machines = fleetMachines(entries)
  const current = machines.find((machine) => machine.id === currentMachineId)
  const others = entries.filter((entry) => entry.kind !== "machine" || entry.machine.id !== currentMachineId)
  // A move lands on a daemon, and only a machine entry names one.
  const transferTargets = machines.filter((machine) => machine.id !== currentMachineId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="px-1"
          aria-label={`Machine ${current?.label ?? "unknown"}, open the device menu`}
        >
          <Badge variant="machine">{current?.label ?? "unknown"}</Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Machines</DropdownMenuLabel>
        {current ? (
          <DropdownMenuItem disabled className="flex-col items-start gap-0.5">
            <span className="font-medium text-strong">{current.label}</span>
            <span className="font-machine text-[10px] text-faint">
              {current.connection} · {healthLabel[current.health]} ·{" "}
              {sessionSummary(currentSessionCount)} · This machine
            </span>
          </DropdownMenuItem>
        ) : null}
        {others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.map((entry) => entryItem(entry, onSelectMachine))}
        {onTransferSession && transferTargets.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Move this session to</DropdownMenuLabel>
            {transferTargets.map((machine) => {
              const selection = machineSelection(machine)
              return (
                <DropdownMenuItem
                  key={`transfer-${machine.id}`}
                  disabled={!selection.selectable}
                  className="flex-col items-start gap-0.5"
                  {...(selection.selectable
                    ? { onSelect: () => onTransferSession(machine.id) }
                    : {})}
                >
                  <span className="font-medium text-strong">
                    Move this session to {machine.label}
                  </span>
                  {selection.selectable ? null : (
                    <span className="font-machine text-[10px] text-faint">{selection.reason}</span>
                  )}
                </DropdownMenuItem>
              )
            })}
          </>
        ) : null}
        <DropdownMenuSeparator />
        {onPairMachine ? (
          <DropdownMenuItem onSelect={() => onPairMachine()}>+ Pair a machine</DropdownMenuItem>
        ) : null}
        {others.length > 0 ? null : (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            No other machines are paired
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
