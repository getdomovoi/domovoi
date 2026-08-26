import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { WorkspaceShell } from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceShell
      clientKind="desktop"
      rpcUrl="ws://127.0.0.1:47831/rpc"
      windowBridge={window.domovoiDesktop}
    />
  </StrictMode>,
)
