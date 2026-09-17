import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import {
  applyStoredAppearanceTheme,
  BrowserLimitsPanel,
  DaemonCredentialPrompt,
  localStorageRelayPinStorage,
  WorkspaceErrorBoundary,
  WorkspaceShell,
} from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"
import { DomovoiClient } from "@/client"

applyStoredAppearanceTheme()

import { browserLimits } from "./browser-limits"
import { browserLimitsSeen, markBrowserLimitsSeen } from "./browser-limits-seen"
import { browserPlatformEnvironment, createBrowserPlatform } from "./browser-platform"
import { clientKindForBrowser } from "./client-kind"
import { registerDomovoiServiceWorker } from "./pwa"
import { pairBrowserDevice } from "./daemon-pairing"
import {
  browserDeviceLabel,
  clearDaemonSession,
  forgetSupersededCredential,
  loadDaemonSession,
  saveDaemonSession,
} from "./credential"

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

function DomovoiWeb() {
  const [session, setSession] = useState(() => loadDaemonSession(sessionStorage))
  const [pairing, setPairing] = useState(false)
  const [pairingError, setPairingError] = useState("")
  // The limits are stated once per tab, after pairing and before the session,
  // so a refusal inside the session is never the first time a person hears
  // of it. A tab that cannot keep session storage sees them every time,
  // which is itself one of the rows.
  const [limitsSeen, setLimitsSeen] = useState(() => browserLimitsSeen(sessionStorage))

  if (!session) {
    return <DaemonCredentialPrompt
      pending={pairing}
      error={pairingError}
      onSubmit={(bearer) => {
        setPairing(true)
        setPairingError("")
        void pairBrowserDevice({
          url: rpcUrl,
          client: clientKind,
          bearer,
          label: browserDeviceLabel(clientKind, crypto.randomUUID().slice(0, 8)),
          createClient: (input) => new DomovoiClient(input.url, input.client, {
            budgets: { connectMs: 30_000, requestMs: 30_000 },
            authToken: input.bearer,
          }),
        }).then((paired) => {
          saveDaemonSession(sessionStorage, paired)
          setSession(paired)
        }).catch((cause: unknown) => {
          setPairingError(cause instanceof Error ? cause.message : "This browser could not be paired with the daemon")
        }).finally(() => {
          setPairing(false)
        })
      }}
    />
  }

  if (!limitsSeen) {
    return <BrowserLimitsPanel
      rows={browserLimits(environment, rpcUrl, markBrowserLimitsSeen(sessionStorage))}
      onContinue={() => setLimitsSeen(true)}
    />
  }
  return (
    <WorkspaceShell
      clientKind={clientKind}
      rpcUrl={rpcUrl}
      rpcToken={session.token}
      platform={platform}
      relayPinStorage={localStorageRelayPinStorage()}
      onChangeCredential={() => {
        clearDaemonSession(sessionStorage)
        setSession(undefined)
      }}
    />
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><WorkspaceErrorBoundary><DomovoiWeb /></WorkspaceErrorBoundary></StrictMode>,
)
