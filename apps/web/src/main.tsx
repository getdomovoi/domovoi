import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import {
  applyStoredAppearanceTheme,
  localStorageRelayPinStorage,
  WorkspaceErrorBoundary,
  WorkspaceShell,
} from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"
import { DomovoiClient } from "@/client"

applyStoredAppearanceTheme()

import { browserPlatformEnvironment, createBrowserPlatform } from "./browser-platform"
import { clientKindForBrowser } from "./client-kind"
import { registerDomovoiServiceWorker } from "./pwa"
import { forgetSupersededCredential } from "./credential"
import { WebApp } from "./web-app"

const rpcUrl = import.meta.env.VITE_DOMOVOI_RPC_URL ?? "ws://127.0.0.1:47831/rpc"
const clientKind = clientKindForBrowser({
  coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  maxTouchPoints: navigator.maxTouchPoints,
  platform: navigator.platform,
  userAgent: navigator.userAgent,
  viewportWidth: window.innerWidth,
})
const environment = browserPlatformEnvironment(window)
const platform = createBrowserPlatform(environment)

forgetSupersededCredential(sessionStorage)

// A code the machine's QR put in the address bar is read once and removed, so
// it is not kept in history or sent on with the next navigation.
const codeFromUrl = new URL(window.location.href).searchParams.get("code") ?? undefined
if (codeFromUrl !== undefined) {
  const clean = new URL(window.location.href)
  clean.searchParams.delete("code")
  window.history.replaceState(window.history.state, "", clean.toString())
}

if ("serviceWorker" in navigator) {
  void registerDomovoiServiceWorker(navigator.serviceWorker, import.meta.env.PROD).catch(() => undefined)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceErrorBoundary>
      <WebApp
        rpcUrl={rpcUrl}
        clientKind={clientKind}
        environment={environment}
        storage={sessionStorage}
        memory={localStorage}
        codeFromUrl={codeFromUrl}
        createClient={(input) => new DomovoiClient(input.url, input.client, {
          budgets: { connectMs: 30_000, requestMs: 30_000 },
          ...(input.bearer ? { authToken: input.bearer } : {}),
        })}
        labelSuffix={() => crypto.randomUUID().slice(0, 8)}
        workspace={({ token, onChangeCredential }) => (
          <WorkspaceShell
            clientKind={clientKind}
            rpcUrl={rpcUrl}
            rpcToken={token}
            platform={platform}
            relayPinStorage={localStorageRelayPinStorage()}
            onChangeCredential={onChangeCredential}
          />
        )}
      />
    </WorkspaceErrorBoundary>
  </StrictMode>,
)
