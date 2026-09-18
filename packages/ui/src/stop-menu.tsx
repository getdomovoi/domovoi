import { CircleStopIcon, PauseIcon, TriangleAlertIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"

// Desktop V2's "Stop everything" control: two options the wiring had collapsed
// into one button called Pause all. Pausing stops at the next turn boundary and
// loses nothing; the emergency stop kills processes now. They are different
// things and this is where a person tells them apart.
export function StopMenu({ connected, pending, onPauseAll, onEmergencyStop }: {
  connected: boolean
  pending: boolean
  onPauseAll: () => void
  onEmergencyStop: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Stop everything" disabled={!connected || pending}>
          <CircleStopIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Stop everything</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={onPauseAll} className="flex-col items-start gap-0.5">
          <span className="flex items-center gap-2 font-medium"><PauseIcon className="size-3.5" />Pause everything</span>
          <span className="text-[11.5px] text-muted-foreground">Stops at the next turn boundary. Nothing is killed.</span>
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onEmergencyStop} className="flex-col items-start gap-0.5">
          <span className="flex items-center gap-2 font-medium"><TriangleAlertIcon className="size-3.5" />Emergency stop</span>
          <span className="text-[11.5px]">Kills processes now. Half-written files stay half-written.</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
