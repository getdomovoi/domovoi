import type {
  DaemonOwner,
  DaemonRefusalReason,
  DesktopDaemonAcquisition,
  DesktopDaemonBridge,
} from "../../shared/daemon-acquisition.js"

export type DesktopDaemonConnection =
  | { kind: "owned" }
  | { kind: "attached"; owner: DaemonOwner }

export type DesktopStartup =
  | { kind: "launch-smoke" }
  | { kind: "workspace"; rpcUrl: string; rpcToken: string; daemon: DesktopDaemonConnection }
  | { kind: "refused"; reason: DaemonRefusalReason; message: string }

export type DesktopStartupWindow = {
  domovoiDesktop?: Pick<DesktopDaemonBridge, "acquireDaemon">
  domovoiLaunchSmoke?: unknown
}

export function startupFromAcquisition(acquisition: DesktopDaemonAcquisition): DesktopStartup {
  if (acquisition.kind === "refused") {
    return { kind: "refused", reason: acquisition.reason, message: acquisition.message }
  }
  return {
    kind: "workspace",
    rpcUrl: acquisition.url,
    rpcToken: acquisition.token,
    daemon: acquisition.kind === "owned" ? { kind: "owned" } : { kind: "attached", owner: acquisition.owner },
  }
}

// The launch smoke only proves the packaged app reaches its renderer, so it is
// settled before any credential is requested from the main process.
export async function resolveDesktopStartup(window: DesktopStartupWindow): Promise<DesktopStartup> {
  if (!window.domovoiDesktop) throw new Error("Desktop bridge is unavailable")
  if (window.domovoiLaunchSmoke) return { kind: "launch-smoke" }
  return startupFromAcquisition(await window.domovoiDesktop.acquireDaemon())
}

// A daemon this app owns cannot move, so its endpoint is answered from what
// startup acquired. An attached owner can restart on another endpoint, so
// every dial asks the main process to attach again and read the current one.
export function desktopRpcEndpointResolver(
  startup: Pick<Extract<DesktopStartup, { kind: "workspace" }>, "rpcUrl" | "rpcToken" | "daemon">,
  bridge: Pick<DesktopDaemonBridge, "reacquireDaemon">,
): () => Promise<{ url: string; token: string }> {
  if (startup.daemon.kind === "owned") return async () => ({ url: startup.rpcUrl, token: startup.rpcToken })
  return async () => {
    const acquisition = await bridge.reacquireDaemon()
    if (acquisition.kind === "refused") throw new Error(acquisition.message)
    return { url: acquisition.url, token: acquisition.token }
  }
}
