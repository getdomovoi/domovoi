import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import { DaemonCredentialPrompt, WorkspaceErrorBoundary, WorkspaceShell } from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"

import { clientKindForBrowser } from "./client-kind"
import { registerDomovoiServiceWorker } from "./pwa"
import {
  clearDaemonCredential,
  loadDaemonCredential,
  saveDaemonCredential,
} from "./credential"

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

function DomovoiWeb() {
  const [credential, setCredential] = useState(() => loadDaemonCredential(sessionStorage))

  if (!credential) {
    return <DaemonCredentialPrompt onSubmit={(value) => {
      saveDaemonCredential(sessionStorage, value)
      setCredential(value)
    }} />
  }

  return (
    <WorkspaceShell
      clientKind={clientKind}
      rpcUrl={rpcUrl}
      rpcToken={credential}
      onChangeCredential={() => {
        clearDaemonCredential(sessionStorage)
        setCredential("")
      }}
    />
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><WorkspaceErrorBoundary><DomovoiWeb /></WorkspaceErrorBoundary></StrictMode>,
)
