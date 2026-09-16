import type { ProviderModel, Runtime } from "@getdomovoi/protocol"
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { providerDisplayName, providerHandoffDescription, requiresProviderHandoff, selectRuntimeModel } from "./runtime.js"

export function providerHandoffChoices(pending: boolean, forkBlockedReason: string | undefined) {
  return [
    { label: "Switch here", variant: "outline" as const, disabled: pending },
    {
      label: "Fork session",
      variant: "default" as const,
      disabled: pending || Boolean(forkBlockedReason),
    },
  ] as const
}

export type ProviderChoice = {
  model: ProviderModel
  requestId: string
}

export function openProviderChoice(
  runtime: Runtime,
  model: ProviderModel,
  createRequestId: () => string = () => crypto.randomUUID(),
): ProviderChoice | undefined {
  if (runtime.provider === model.provider && runtime.model === model.id) return undefined
  return { model, requestId: createRequestId() }
}

export function forkProviderChoice(
  runtime: Runtime,
  choice: ProviderChoice,
  checkpointId: string,
  onFork: (runtime: Runtime, checkpointId: string, requestId: string) => Promise<void>,
): Promise<void> {
  return onFork(selectRuntimeModel(runtime, choice.model), checkpointId, choice.requestId)
}

// Choosing another model is a decision with two answers: change this session
// at the next safe boundary, or fork a new one from the last checkpoint. The
// dialog holds one fork request id per choice so a retry after a failure
// reuses it rather than forking twice.
export function ProviderChoiceDialog({
  runtime,
  model,
  pending,
  forkCheckpointId,
  forkBlockedReason,
  onClose,
  onSwitch,
  onFork,
}: {
  runtime: Runtime
  model: ProviderModel | undefined
  pending: boolean
  forkCheckpointId?: string | undefined
  forkBlockedReason?: string | undefined
  onClose: () => void
  onSwitch: (model: ProviderModel) => void
  onFork: (runtime: Runtime, checkpointId: string, requestId: string) => Promise<void>
}) {
  const [choice, setChoice] = useState<ProviderChoice>()
  const [forking, setForking] = useState(false)
  useEffect(() => {
    setChoice(model ? openProviderChoice(runtime, model) : undefined)
    // The request id belongs to the model offered, not to the runtime it is
    // compared against; a runtime change while the dialog is open keeps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])
  const actionPending = pending || forking
  const choices = providerHandoffChoices(actionPending, forkBlockedReason)

  const submitFork = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (!choice || !forkCheckpointId || forkBlockedReason || actionPending) return
    setForking(true)
    try {
      await forkProviderChoice(runtime, choice, forkCheckpointId, onFork)
      onClose()
    } catch {
      // The parent surfaces the RPC error. Keep this attempt and request ID open for retry.
    } finally {
      setForking(false)
    }
  }

  return (
    <AlertDialog open={choice !== undefined} onOpenChange={(open) => { if (!open && !actionPending) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch here or fork session?</AlertDialogTitle>
          <AlertDialogDescription>
            {choice
              ? requiresProviderHandoff(runtime, choice.model)
                ? providerHandoffDescription(providerDisplayName(choice.model.provider), choice.model.displayName)
                : `Switch here changes this session to ${choice.model.displayName}.`
              : null}
            {choice
              ? ` Fork session starts ${providerDisplayName(choice.model.provider)} / ${choice.model.displayName} in a separate worktree from the latest durable checkpoint. Domovoi records the source, checkpoint, provider/model, and requesting client in its history.`
              : null}
            {forkBlockedReason ? ` Fork unavailable: ${forkBlockedReason}.` : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={actionPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={choices[0].variant}
            disabled={choices[0].disabled}
            onClick={() => { if (choice) onSwitch(choice.model) }}
          >
            {choices[0].label}
          </AlertDialogAction>
          <AlertDialogAction
            variant={choices[1].variant}
            disabled={choices[1].disabled}
            title={forkBlockedReason}
            onClick={(event) => void submitFork(event)}
          >
            {choices[1].label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
