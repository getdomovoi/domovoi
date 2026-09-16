import type { PermissionMode, Runtime } from "@getdomovoi/protocol"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { useRef, useState } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Switch } from "./components/ui/switch"
import { FloatingSurface } from "./floating-surface"
import { autoIsOffered, permissionModeLabel, permissionModes, withAuto, withPermissionMode } from "./permission-mode"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { cn } from "./lib/utils"

// v2's composer carries the permission mode as a coloured chip beside the
// model, "Build · auto" when auto is on, opening "MODE FOR THE NEXT TURN":
// the three modes with a line each, and an Auto row that is live only in
// Build and says why elsewhere. Ask, Plan and Build are modes; Auto is a
// separate control that cannot outlive Build.
export function ModeChip({
  runtime,
  pending,
  onSetRuntime,
}: {
  runtime: Runtime
  pending: boolean
  onSetRuntime: (runtime: Runtime) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = permissionModes.find((mode) => mode.id === runtime.permissionMode)!
  const label = permissionModeLabel(runtime.permissionMode, runtime.auto)
  const autoOffered = autoIsOffered(runtime.permissionMode)

  return (
    <div className="relative flex">
      <button
        ref={trigger}
        type="button"
        aria-label={`Mode: ${label}`}
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[11px] font-medium",
          open ? "bg-accent" : "bg-muted/60",
          "disabled:cursor-not-allowed disabled:opacity-45",
        )}
      >
        <StatusDot meaning={current.meaning as StatusMeaning} label={label} size="inline" />
        <ChevronDownIcon className={cn("size-3 text-faint transition-transform", open && "rotate-180")} />
      </button>
      <FloatingSurface
        open={open}
        onClose={() => setOpen(false)}
        label="Mode for the next turn"
        trigger={trigger}
        className="bottom-[calc(100%+8px)] top-auto w-[300px] p-0"
      >
        <div className="border-b px-3 py-2 text-eyebrow font-medium tracking-[.13em] text-faint">MODE FOR THE NEXT TURN</div>
        <div role="listbox" aria-label="Permission modes">
          {permissionModes.map((mode) => {
            const selected = mode.id === runtime.permissionMode
            return (
              <div
                key={mode.id}
                role="option"
                aria-label={mode.label}
                aria-selected={selected}
                tabIndex={0}
                onClick={() => { onSetRuntime(withPermissionMode(runtime, mode.id as PermissionMode)); setOpen(false) }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSetRuntime(withPermissionMode(runtime, mode.id as PermissionMode)); setOpen(false) } }}
                className={cn("flex cursor-pointer items-start gap-2.5 border-t px-3 py-2.5 first:border-t-0", selected && "bg-accent")}
              >
                <StatusDot meaning={mode.meaning as StatusMeaning} label={mode.label} size="inline" labelHidden className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-foreground">{mode.label}</div>
                  <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted-foreground">{mode.note}</p>
                </div>
                <CheckIcon className={cn("size-3.5 self-center", selected ? "text-primary" : "text-transparent")} />
              </div>
            )
          })}
        </div>
        <label className={cn("flex items-center gap-3 border-t px-3 py-2.5", !autoOffered && "opacity-60")}>
          <div className="min-w-0 flex-1">
            <div className={cn("text-[12.5px]", autoOffered ? "text-foreground" : "text-faint")}>{runtime.auto ? "Auto, on" : "Auto"}</div>
            <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {autoOffered
                ? "Runs step after step without stopping between them. Hard gates and policy refusals still stop it."
                : "Only legal with Build, because Plan and Ask stop on every step by definition."}
            </p>
          </div>
          <Switch
            aria-label="Auto"
            size="sm"
            checked={runtime.auto}
            disabled={!autoOffered || pending}
            onCheckedChange={(checked) => onSetRuntime(withAuto(runtime, checked))}
          />
        </label>
      </FloatingSurface>
    </div>
  )
}

// v2 draws no reasoning control. The runtime carries one and the model
// reports which efforts it takes, so the chip stays, plain, beside the mode.
export function ThinkChip({
  runtime,
  options,
  pending,
  onSetRuntime,
}: {
  runtime: Runtime
  options: readonly string[]
  pending: boolean
  onSetRuntime: (runtime: Runtime) => void
}) {
  const none = options.length === 0
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Think: ${runtime.reasoning}`}
          disabled={pending || none}
          {...(none ? { title: "This model reports no reasoning efforts to choose from." } : {})}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-[5px] font-machine text-mono-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45"
        >
          Think: {runtime.reasoning}
          <ChevronDownIcon className="size-3 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((reasoning) => (
          <DropdownMenuItem key={reasoning} disabled={pending} onSelect={() => onSetRuntime({ ...runtime, reasoning })}>
            {reasoning === runtime.reasoning ? <CheckIcon /> : null}{reasoning}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
