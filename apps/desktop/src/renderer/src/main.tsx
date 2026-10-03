import { StrictMode, useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"

import {
  applyStoredAppearanceTheme,
  bridgeRelayPinStorage,
  CommandLinksProvider,
  FirstRunServiceContext,
  useCommandLinkView,
  StartupError,
  WorkspaceErrorBoundary,
  WorkspaceShell,
} from "@getdomovoi/ui"
import "@getdomovoi/ui/styles.css"

import { daemonConnectionCopy } from "./desktop-daemon-copy.js"
import { DesktopDaemonRefused } from "./desktop-daemon-refused.js"
import { desktopRpcEndpointResolver, resolveDesktopStartup, type DesktopStartup } from "./desktop-startup.js"
import { desktopFirstRunService, type ServiceFacts } from "./first-run-service.js"
import { verifyLaunchSmokeDaemon } from "./launch-smoke.js"

applyStoredAppearanceTheme()

const root = createRoot(document.getElementById("root")!)

type DesktopState =
  | { kind: "resolving" }
  | { kind: "failed"; message: string }
  | DesktopStartup

function DesktopLaunchSmoke({ startup }: { startup: DesktopStartup }) {
  useEffect(() => {
    void verifyLaunchSmokeDaemon(startup).then(
      () => window.domovoiLaunchSmoke?.ready(),
      (error: unknown) => window.domovoiLaunchSmoke?.failed(error instanceof Error ? error.message : "Daemon verification failed"),
    )
  }, [startup])
  return <div data-domovoi-launch-smoke="verifying-daemon" />
}

function startupFailure(error: unknown): DesktopState {
  return { kind: "failed", message: error instanceof Error ? error.message : "Desktop authentication failed" }
}

function DesktopApp() {
  const [state, setState] = useState<DesktopState>({ kind: "resolving" })
  const [retrying, setRetrying] = useState(false)
  // Q336 A: printed commands name what runs, here and in the workspace.
  const links = useCommandLinkView()

  useEffect(() => {
    let active = true
    resolveDesktopStartup(window).then(
      (startup) => { if (active) setState(startup) },
      (error: unknown) => {
        window.domovoiLaunchSmoke?.failed(error instanceof Error ? error.message : "Startup failed")
        if (active) setState(startupFailure(error))
      },
    )
    return () => { active = false }
  }, [])

  const retry = () => {
    setRetrying(true)
    resolveDesktopStartup(window)
      .then(setState, (error: unknown) => setState(startupFailure(error)))
      .finally(() => setRetrying(false))
  }
  const workspace = state.kind === "workspace" ? state : undefined
  const relayPinStorage = useMemo(() => bridgeRelayPinStorage(window.domovoiDesktop), [])
  const resolveRpcEndpoint = useMemo(
    () => workspace ? desktopRpcEndpointResolver(workspace, window.domovoiDesktop) : undefined,
    [workspace],
  )
  // The service as read back after first-run setup installed it. The shell's
  // own service changes clear it, and its own reads take over.
  const [serviceFacts, setServiceFacts] = useState<ServiceFacts>({})
  const firstRunService = useMemo(
    () => workspace ? desktopFirstRunService({
      bridge: window.domovoiDesktop,
      owner: daemonConnectionCopy(workspace.daemon).owner,
      endpoint: workspace.rpcUrl,
      onDaemonMoved: (facts) => {
        setServiceFacts(facts)
        retry()
      },
    }) : undefined,
    [workspace],
  )

  if (state.kind === "resolving") return null
  if (state.kind === "failed") return <StartupError message={state.message} />
  if (window.domovoiLaunchSmoke) return <DesktopLaunchSmoke startup={state} />
  if (state.kind === "refused") {
    return <DesktopDaemonRefused reason={state.reason} message={state.message} retrying={retrying} onRetry={retry} links={links} />
  }
  return (
    <StrictMode>
      <WorkspaceErrorBoundary>
        <FirstRunServiceContext.Provider value={firstRunService}>
          <WorkspaceShell
            clientKind="desktop"
            rpcUrl={state.rpcUrl}
            rpcToken={state.rpcToken}
            {...(resolveRpcEndpoint ? { resolveRpcEndpoint } : {})}
            localDaemon={{ ...daemonConnectionCopy(state.daemon), ...serviceFacts }}
            onLocalDaemonChanged={() => {
              setServiceFacts({})
              retry()
            }}
            windowBridge={window.domovoiDesktop}
            {...(relayPinStorage ? { relayPinStorage } : {})}
          />
        </FirstRunServiceContext.Provider>
      </WorkspaceErrorBoundary>
    </StrictMode>
  )
}

// The ~/.local/bin links (Q336 A), read once at startup and after each change
// from Settings.
root.render(<CommandLinksProvider bridge={window.domovoiDesktop}><DesktopApp /></CommandLinksProvider>)
