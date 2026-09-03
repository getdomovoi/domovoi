import { CircleStopIcon } from "lucide-react"
import { Component, type ErrorInfo, type ReactNode } from "react"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { DomovoiMark } from "./domovoi-mark"

type WorkspaceErrorBoundaryState = { error: Error | null }

export class WorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  WorkspaceErrorBoundaryState
> {
  override state: WorkspaceErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Domovoi UI failed to render", error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
          <div className="w-full max-w-md space-y-4">
            <DomovoiMark className="size-9 text-primary" />
            <h1 className="sr-only">Domovoi could not show this workspace</h1>
            <Alert variant="destructive">
              <CircleStopIcon />
              <AlertTitle>Domovoi could not show this workspace</AlertTitle>
              <AlertDescription>{this.state.error.message}</AlertDescription>
            </Alert>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
