import type { FleetHealth, FleetMachine } from "@getdomovoi/protocol"

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
}

const unavailableReason = "Machine transfer is not available yet"

function sessionSummary(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`
}

export function MachineSwitcher({
  machines,
  currentMachineId,
  currentSessionCount,
}: {
  machines: FleetMachine[]
  currentMachineId: string
  currentSessionCount: number
}) {
  const current = machines.find((machine) => machine.id === currentMachineId)
  const others = machines.filter((machine) => machine.id !== currentMachineId)

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
        {others.map((machine) => (
          <DropdownMenuItem key={machine.id} disabled className="flex-col items-start gap-0.5">
            <span className="font-medium text-strong">{machine.label}</span>
            <span className="font-machine text-[10px] text-faint">
              {machine.connection} · {healthLabel[machine.health]}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {others.length > 0 ? unavailableReason : "No other machines are paired"}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
