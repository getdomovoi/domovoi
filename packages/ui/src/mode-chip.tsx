import type { PermissionMode, Runtime } from "@getdomovoi/protocol"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { useRef, useState } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Switch } from "./components/ui/switch"
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

  // Not modal: this is a surface beside the composer, not a dialog. Modal is
  // the Radix default and it marks the rest of the page aria-hidden, which
  // takes the composer and the chip itself out of the accessibility tree while
  // the list is open.
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={`Mode: ${label}`}
          disabled={pending}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[11px] font-medium",
            open ? "bg-accent" : "bg-muted/60",
            "disabled:cursor-not-allowed disabled:opacity-45",
          )}
        >
          <StatusDot meaning={current.meaning as StatusMeaning} label={label} size="inline" />
          <ChevronDownIcon className={cn("size-3 text-faint transition-transform", open && "rotate-180")} />
        </button>
      </DropdownMenuTrigger>
      {/* This list sits at the bottom of the composer and opens upward. It used
          FloatingSurface, which positions absolutely and was cut off by an
          ancestor, losing the first rows: Plan and Ask were unreachable on a
          real screen while every test passed, because jsdom has no layout. The
          portalled dropdown primitive renders outside the composer, where
          nothing clips it. */}
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[300px] p-0">
        <div className="border-b px-3 py-2 text-eyebrow font-medium tracking-[.13em] text-faint">MODE FOR THE NEXT TURN</div>
        <div role="listbox" aria-label="Permission modes">
          {permissionModes.map((mode) => {
            const selected = mode.id === runtime.permissionMode
            // An update in flight holds the rows too, not only the trigger: a
            // pick made now would be dropped by the pending guard upstream,
            // and a row that looks live while its choice goes nowhere lies.
            const pick = () => {
              if (pending) return
              onSetRuntime(withPermissionMode(runtime, mode.id as PermissionMode))
              setOpen(false)
            }
            return (
              <div
                key={mode.id}
                role="option"
                aria-label={mode.label}
                aria-selected={selected}
                aria-disabled={pending || undefined}
                tabIndex={0}
                onClick={pick}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick() } }}
                className={cn("flex items-start gap-2.5 border-t px-3 py-2.5 first:border-t-0", selected && "bg-accent", pending ? "cursor-not-allowed opacity-45" : "cursor-pointer")}
              >
                <StatusDot meaning={mode.meaning as StatusMeaning} label={mode.label} size="inline" labelHidden className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[12.5px] text-foreground">{mode.label}</span>
                    <span className="font-machine text-[10px] text-faint">{mode.id}</span>
                  </div>
                  <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted-foreground">{mode.note}</p>
                </div>
                <CheckIcon className={cn("size-3.5 self-center", selected ? "text-primary" : "text-transparent")} />
              </div>
            )
          })}
        </div>
        {/* Toggling Auto must not close the list: it is a control on the same
            surface, not a choice that ends the interaction. */}
        <label
          onClick={(event) => event.preventDefault()}
          className={cn("flex items-center gap-3 border-t px-3 py-2.5", !autoOffered && "opacity-60")}
        >
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
