import { OctagonXIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { cn } from "./lib/utils"
import { titlebarTipClassName } from "./titlebar-tip"

// Desktop V2's "Stop everything" control: two options the wiring had collapsed
// into one button called Pause all. Pausing stops at the next turn boundary and
// loses nothing; the emergency stop kills processes now. They are different
// things and this is where a person tells them apart. On the titlebar it is an
// octagon icon named by its tooltip, like every other control on that row.
export function StopMenu({ connected, pending, disabled = false, onPauseAll, onEmergencyStop }: {
  connected: boolean
  pending: boolean
  disabled?: boolean
  onPauseAll: () => void
  onEmergencyStop: () => void
}) {
  const [open, setOpen] = useState(false)
  // The tooltip is the icon's only visible name. A disabled button takes no
  // pointer events and no focus, so the name would vanish exactly when someone
  // wants to know why it does nothing. The control stays focusable and
  // hoverable, says it is unavailable through aria-disabled, and refuses to
  // open its menu.
  const unavailable = disabled || !connected || pending
  return (
    <TooltipProvider>
      <DropdownMenu open={open && !unavailable} onOpenChange={(next) => setOpen(next && !unavailable)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "electron-no-drag size-7 shrink-0 text-muted-foreground",
                  unavailable
                    ? "opacity-50"
                    : "hover:bg-danger-background hover:text-danger-foreground aria-expanded:bg-danger-background aria-expanded:text-danger-foreground",
                )}
                aria-label="Stop everything"
                aria-disabled={unavailable || undefined}
              >
                <OctagonXIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={7} showArrow={false} className={titlebarTipClassName}>
            Stop everything, every machine
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={7} className="w-[380px] overflow-hidden rounded-[14px] border border-danger-border p-0">
          <DropdownMenuLabel className="border-b border-border px-[13px] py-2.5 text-[10.5px] font-medium tracking-[.13em] text-faint">
            STOP EVERYTHING, ON EVERY MACHINE
          </DropdownMenuLabel>
          <StopOption tone="info" label="Pause everything" note="Stops at the next turn boundary, nothing is killed." onSelect={onPauseAll} />
          <StopOption tone="destructive" label="Emergency stop" note="Kills processes now. Half-written files stay half-written." onSelect={onEmergencyStop} />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

function StopOption({ tone, label, note, onSelect }: {
  tone: "info" | "destructive"
  label: string
  note: string
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn("items-start gap-2.5 rounded-none px-[13px] py-[11px]", tone === "destructive" && "border-t border-border")}
    >
      <span aria-hidden className={cn("mt-1 size-[7px] shrink-0 rounded-full", tone === "info" ? "bg-info" : "bg-destructive")} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[12.5px]", tone === "destructive" ? "text-danger-foreground" : "text-foreground")}>{label}</span>
        <span className="mt-1 block text-[11px] leading-normal text-muted-foreground">{note}</span>
      </span>
    </DropdownMenuItem>
  )
}
