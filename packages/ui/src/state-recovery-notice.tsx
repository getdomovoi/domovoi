import type { StateRecovery } from "@getdomovoi/protocol"
import { CircleStopIcon } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"

export function StateRecoveryNotice({
  recovery,
  onDismiss,
  className,
}: {
  recovery: StateRecovery
  onDismiss: () => void
  className?: string
}) {
  const subject = recovery.kind === "database" ? "state database" : "workspace"
  return (
    <Alert variant="warning" className={className}>
      <CircleStopIcon />
      <AlertTitle>Stored {subject} could not be read</AlertTitle>
      <AlertDescription className="flex flex-col gap-1.5">
        <p className="m-0">
          Domovoi started from an empty workspace. The unreadable copy was kept at{" "}
          <code className="break-all font-machine text-[11px]">{recovery.quarantinedPath}</code>
        </p>
        <p className="m-0">
          {recovery.pairedDevicesKept
            ? "Paired devices were kept."
            : "Paired devices could not be read from it. Pair them again."}
        </p>
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </AlertAction>
    </Alert>
  )
}
