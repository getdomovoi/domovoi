import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { DomovoiMark } from "@/domovoi-mark"

import type { DaemonRefusalReason } from "../../shared/daemon-acquisition.js"
import { daemonRefusalCopy } from "./desktop-daemon-copy.js"

export function DesktopDaemonRefused({ reason, message, retrying, onRetry }: {
  reason: DaemonRefusalReason
  message: string
  retrying: boolean
  onRetry: () => void
}) {
  const copy = daemonRefusalCopy({ reason, message })
  return (
    <main className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md space-y-4">
        <DomovoiMark className="size-9 text-primary" />
        <h1 className="sr-only">Domovoi could not reach a local daemon</h1>
        <Alert variant="destructive">
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.detail}</AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
          {retrying ? "Trying again" : "Try again"}
        </Button>
      </div>
    </main>
  )
}
