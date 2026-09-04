import type { DesktopWindowBridge } from "@getdomovoi/ui"

export type DesktopStartup =
  | { kind: "launch-smoke" }
  | { kind: "workspace"; rpcUrl: string; rpcToken: string }

export type DesktopStartupWindow = {
  domovoiDesktop?: Pick<DesktopWindowBridge, "getRpcEndpoint">
  domovoiLaunchSmoke?: unknown
}

// The launch smoke only proves the packaged app reaches its renderer, so it is
// settled before any credential is requested from the main process.
export async function resolveDesktopStartup(window: DesktopStartupWindow): Promise<DesktopStartup> {
  if (!window.domovoiDesktop) throw new Error("Desktop bridge is unavailable")
  if (window.domovoiLaunchSmoke) return { kind: "launch-smoke" }
  const endpoint = await window.domovoiDesktop.getRpcEndpoint()
  return { kind: "workspace", rpcUrl: endpoint.url, rpcToken: endpoint.token }
}
