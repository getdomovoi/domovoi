import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"

import {
  applyStoredAppearanceTheme,
  StartupError,
  WorkspaceErrorBoundary,
  WorkspaceShell,
} from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"

import { DesktopDaemonRefused } from "./desktop-daemon-refused.js"
import { resolveDesktopStartup, type DesktopStartup } from "./desktop-startup.js"

applyStoredAppearanceTheme()

const root = createRoot(document.getElementById("root")!)

type DesktopState =
  | { kind: "resolving" }
  | { kind: "failed"; message: string }
  | DesktopStartup

function DesktopLaunchSmoke() {
  useEffect(() => window.domovoiLaunchSmoke?.ready(), [])
  return <div data-domovoi-launch-smoke="ready" />
}

function startupFailure(error: unknown): DesktopState {
  return { kind: "failed", message: error instanceof Error ? error.message : "Desktop authentication failed" }
}

function DesktopApp() {
  const [state, setState] = useState<DesktopState>({ kind: "resolving" })
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let active = true
    resolveDesktopStartup(window).then(
      (startup) => { if (active) setState(startup) },
      (error: unknown) => { if (active) setState(startupFailure(error)) },
    )
    return () => { active = false }
  }, [])

  const retry = () => {
    setRetrying(true)
    resolveDesktopStartup(window)
      .then(setState, (error: unknown) => setState(startupFailure(error)))
      .finally(() => setRetrying(false))
  }

  if (state.kind === "resolving") return null
  if (state.kind === "launch-smoke") return <DesktopLaunchSmoke />
  if (state.kind === "failed") return <StartupError message={state.message} />
  if (state.kind === "refused") {
    return <DesktopDaemonRefused reason={state.reason} message={state.message} retrying={retrying} onRetry={retry} />
  }
  return (
    <StrictMode>
      <WorkspaceErrorBoundary>
        <WorkspaceShell
          clientKind="desktop"
          rpcUrl={state.rpcUrl}
          rpcToken={state.rpcToken}
          windowBridge={window.domovoiDesktop}
        />
      </WorkspaceErrorBoundary>
    </StrictMode>
  )
}

root.render(<DesktopApp />)
