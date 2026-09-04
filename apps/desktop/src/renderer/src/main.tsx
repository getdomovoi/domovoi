import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"

import {
  applyStoredAppearanceTheme,
  StartupError,
  WorkspaceErrorBoundary,
  WorkspaceShell,
} from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"

import { resolveDesktopStartup } from "./desktop-startup.js"

applyStoredAppearanceTheme()

const root = createRoot(document.getElementById("root")!)

function DesktopLaunchSmoke() {
  useEffect(() => window.domovoiLaunchSmoke?.ready(), [])
  return <div data-domovoi-launch-smoke="ready" />
}

async function renderDesktop(): Promise<void> {
  try {
    const startup = await resolveDesktopStartup(window)
    if (startup.kind === "launch-smoke") {
      root.render(<DesktopLaunchSmoke />)
      return
    }
    root.render(
      <StrictMode>
        <WorkspaceErrorBoundary>
          <WorkspaceShell
            clientKind="desktop"
            rpcUrl={startup.rpcUrl}
            rpcToken={startup.rpcToken}
            windowBridge={window.domovoiDesktop}
          />
        </WorkspaceErrorBoundary>
      </StrictMode>,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Desktop authentication failed"
    root.render(<StartupError message={message} />)
  }
}

void renderDesktop()
