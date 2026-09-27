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
        {/* Ruled 2026-09-24 (#577, C): an owner this app cannot talk to cannot
            be checked for running work, so no update button; the command is
            shown to copy instead. */}
        {reason === "owner-incompatible" ? (
          <code className="block select-all rounded-md bg-code px-3 py-2 font-machine text-[12px] text-strong">domovoid service install</code>
        ) : null}
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
          {retrying ? "Trying again" : "Try again"}
        </Button>
      </div>
    </main>
  )
}
