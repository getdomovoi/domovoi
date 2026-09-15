import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog"
import { Button } from "./components/ui/button"

// One control for restoring a checkpoint, wherever it is offered. The thread
// and the history pane both reach a destructive action, so they share the
// confirmation copy and the blocked rule rather than drifting apart.
export function CheckpointRestore({
  checkpointId,
  label,
  disabled,
  onRestore,
  triggerLabel = "Restore worktree",
  triggerVariant = "ghost",
}: {
  checkpointId: string
  label: string
  disabled: boolean
  onRestore: (checkpointId: string) => void
  // The thread says "Restore worktree"; the v2 Checkpoints tab says "Revert",
  // and "Reset" on the session start. One dialog, the trigger names its place.
  triggerLabel?: string
  triggerVariant?: "ghost" | "outline"
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={triggerVariant} size="sm" disabled={disabled} className="h-6 rounded-full px-2 text-micro">
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore this checkpoint?</AlertDialogTitle>
          <AlertDialogDescription>
            Domovoi checkpoints the current worktree first, then restores {label}. The
            current state remains available as a recovery checkpoint.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <CheckpointRestoreAction checkpointId={checkpointId} disabled={disabled} onRestore={onRestore} />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// The existing fork starts a fresh provider thread and gives the candidate a
// checkpoint and a system note; it does not replay the source conversation
// (apps/daemon/src/server.ts:6272 and :6324). The label alone promises more
// than that, so the confirm ships both halves the way a provider handoff does:
// what travels, and what does not.
export function CheckpointFork({
  checkpointId,
  label,
  disabled,
  onFork,
  triggerLabel = "Fork from here",
  triggerVariant = "ghost",
}: {
  checkpointId: string
  label: string
  disabled: boolean
  onFork: (checkpointId: string) => void
  triggerLabel?: string
  triggerVariant?: "ghost" | "outline"
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={triggerVariant} size="sm" disabled={disabled} className="h-6 rounded-full px-2 text-micro">
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fork from this checkpoint?</AlertDialogTitle>
          <AlertDialogDescription>
            Domovoi starts a new session in a separate worktree at {label}, and records
            the source checkpoint in its history. The conversation is not replayed:
            the new session begins with a note naming where it came from, not with
            this thread behind it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={() => onFork(checkpointId)}>
            Fork session
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function CheckpointRestoreAction({
  checkpointId,
  disabled,
  onRestore,
}: {
  checkpointId: string
  disabled: boolean
  onRestore: (checkpointId: string) => void
}) {
  return (
    <AlertDialogAction
      disabled={disabled}
      onClick={() => {
        if (!disabled) onRestore(checkpointId)
      }}
    >
      Restore worktree
    </AlertDialogAction>
  )
}

export function checkpointRestoreBlocked(pending: boolean, archiveReadOnly: boolean): boolean {
  return pending || archiveReadOnly
}

export function checkpointBlockedReason(activeTurnId: string | undefined): string | undefined {
  return activeTurnId ? "Stop the active turn before creating a checkpoint" : undefined
}
