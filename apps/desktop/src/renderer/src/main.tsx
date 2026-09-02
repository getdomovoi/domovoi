import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"

import { applyStoredAppearanceTheme, StartupError, WorkspaceShell } from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"

applyStoredAppearanceTheme()

const root = createRoot(document.getElementById("root")!)

function DesktopLaunchSmoke() {
  useEffect(() => window.domovoiLaunchSmoke?.ready(), [])
  return <div data-domovoi-launch-smoke="ready" />
}

async function renderDesktop(): Promise<void> {
  try {
    if (!window.domovoiDesktop) throw new Error("Desktop bridge is unavailable")
    const rpcToken = await window.domovoiDesktop.getRpcToken()
    if (!rpcToken) throw new Error("Desktop authentication token is unavailable")
    if (window.domovoiLaunchSmoke) {
      root.render(<DesktopLaunchSmoke />)
      return
    }
    root.render(
      <StrictMode>
        <WorkspaceShell
          clientKind="desktop"
          rpcUrl="ws://127.0.0.1:47831/rpc"
          rpcToken={rpcToken}
          windowBridge={window.domovoiDesktop}
        />
      </StrictMode>,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Desktop authentication failed"
    root.render(<StartupError message={message} />)
  }
}

void renderDesktop()
