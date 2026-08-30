import { CircleStopIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { DomovoiMark } from "./domovoi-mark"

export function StartupError({ message }: { message: string }) {
  return (
    <main className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md space-y-4">
        <DomovoiMark className="size-9 text-primary" />
        <h1 className="sr-only">Domovoi could not start</h1>
        <Alert variant="destructive">
          <CircleStopIcon />
          <AlertTitle>Domovoi could not start</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </div>
    </main>
  )
}
