import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { WorkspaceShell } from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"

import { clientKindForBrowser } from "./client-kind"
import { registerDomovoiServiceWorker } from "./pwa"

const rpcUrl = import.meta.env.VITE_DOMOVOI_RPC_URL ?? "ws://127.0.0.1:47831/rpc"
const clientKind = clientKindForBrowser({
  coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  maxTouchPoints: navigator.maxTouchPoints,
  platform: navigator.platform,
  userAgent: navigator.userAgent,
  viewportWidth: window.innerWidth,
})

if ("serviceWorker" in navigator) {
  void registerDomovoiServiceWorker(navigator.serviceWorker, import.meta.env.PROD).catch(() => undefined)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceShell clientKind={clientKind} rpcUrl={rpcUrl} />
  </StrictMode>,
)
