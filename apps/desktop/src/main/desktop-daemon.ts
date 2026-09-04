import type { OwnedDaemonLifecycle } from "./owned-daemon.js"

export type DesktopRpcEndpoint = {
  url: string
  token: string
}

export type DesktopDaemonHandle = {
  readonly authToken: string
  start(): Promise<{ url: string }>
  stop(): Promise<void>
}

// The main process, the renderer's credential request, and the quit handler
// all reach the daemon through this one promise, so racing callers share a
// single listener and a single credential no matter who asks first.
export function ownDesktopDaemon(
  build: () => Promise<DesktopDaemonHandle>,
  lifecycle: Pick<OwnedDaemonLifecycle, "start">,
): () => Promise<DesktopRpcEndpoint> {
  let endpoint: Promise<DesktopRpcEndpoint> | undefined
  return () => {
    endpoint ??= (async () => {
      const daemon = await build()
      const address = await lifecycle.start(daemon)
      return { url: address.url, token: daemon.authToken }
    })()
    return endpoint
  }
}
