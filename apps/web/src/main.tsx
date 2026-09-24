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
        createClient={(input) => new DomovoiClient(input.url, input.client, {
          budgets: { connectMs: 30_000, requestMs: 30_000 },
          authToken: input.bearer,
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
