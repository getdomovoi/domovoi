import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { cn } from "../lib/utils"
import { SessionsDrawerColumn, SessionsDrawerTrigger, type SessionRowAction } from "../sessions-drawer"

// The trigger and the column composed the way the shell composes them: the
// trigger in the top bar, the column beside the thread. No surface draws the
// two as one, so the composition lives with the tests that need both.
export function ComposedSessionsDrawer({
  snapshot,
  open,
  onOpenChange,
  onActivate,
  onAction,
  onNewSession,
  onOpenProviderSettings,
  machineAvailability,
  onOpenMachines,
  className,
}: {
  snapshot: WorkspaceSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  onActivate: (sessionId: string) => void
  onAction?: ((action: SessionRowAction, sessionId: string) => void) | undefined
  onNewSession?: (() => void) | undefined
  onOpenProviderSettings?: (() => void) | undefined
  machineAvailability?: string | undefined
  onOpenMachines?: (() => void) | undefined
  className?: string
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      <SessionsDrawerTrigger snapshot={snapshot} open={open} onOpenChange={onOpenChange} className="self-start" />
      <SessionsDrawerColumn
        snapshot={snapshot}
        open={open}
        onActivate={onActivate}
        onAction={onAction}
        onNewSession={onNewSession}
        onOpenProviderSettings={onOpenProviderSettings}
        machineAvailability={machineAvailability}
        onOpenMachines={onOpenMachines}
        className="mt-2 max-h-[70vh]"
      />
    </div>
  )
}
