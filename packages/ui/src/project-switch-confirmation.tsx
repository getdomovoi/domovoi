import type { ProjectSwitchConfirmation } from "@getdomovoi/protocol"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog"
import { Button } from "./components/ui/button"
import { ScrollArea } from "./components/ui/scroll-area"

// The approval a project switch waits on. It loads with the shell, not with
// the launcher: the switch it guards can start from the folder picker before
// the launcher's code has arrived, and what the switch stops must be on screen
// the moment the daemon asks.
export function ProjectSwitchConfirmationDialog({
  confirmation,
  pending = false,
  error = "",
  onCancel,
  onConfirm,
}: {
  confirmation: ProjectSwitchConfirmation
  pending?: boolean
  error?: string
  onCancel: () => void
  onConfirm: (path: string) => void
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop running work and switch projects?</AlertDialogTitle>
          <AlertDialogDescription>
            Domovoi keeps {confirmation.sessionCount} sessions and their saved history, including {confirmation.worktreeCount} isolated {confirmation.worktreeCount === 1 ? "worktree" : "worktrees"}, and restores them when you reopen this project. Switching now stops any turn, provider thread, and terminal that is still running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea className="max-h-44 rounded-md border">
          <ul className="divide-y">
            {confirmation.sessions.map((session) => (
              <li key={session.id} className="px-3 py-2 text-sm">
                <span className="block font-medium text-foreground">{session.title}</span>
                <span className="font-machine text-[10px] text-muted-foreground">{session.workspacePath ?? "No isolated worktree"}</span>
              </li>
            ))}
          </ul>
        </ScrollArea>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep current project</AlertDialogCancel>
          <Button
            disabled={pending}
            onClick={() => onConfirm(confirmation.requestedPath)}
          >
            {pending ? "Switching…" : "Stop work and switch"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
