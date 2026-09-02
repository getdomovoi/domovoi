import type { DaemonErrorSink, DaemonServerOptions } from "./server.js"
import { DomovoiDaemon as DomovoiDaemonImplementation } from "./server.js"

export type { DaemonErrorEntry, DaemonErrorSink } from "./server.js"

// The daemon's constructor takes every seam its own tests inject. A consumer
// embedding the daemon configures a listener and its credentials, so the
// published entry names only those and leaves the injection points to
// "@getdomovoi/daemon/internal".
export type DomovoiDaemonOptions = Pick<
  DaemonServerOptions,
  | "host"
  | "port"
  | "advertiseHost"
  | "allowedOrigins"
  | "allowRemoteTransport"
  | "tls"
  | "authToken"
  | "authTimeoutMs"
  | "statePath"
  | "worktreeRoot"
  | "agentTimeoutMs"
> & { errorSink?: DaemonErrorSink }

export type DomovoiDaemonInstance = {
  readonly host: string
  readonly requestedPort: number
  readonly allowedOrigins: ReadonlySet<string>
  readonly authToken: string
  start(): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}

export type DomovoiDaemonConstructor = new (
  options?: DomovoiDaemonOptions,
) => DomovoiDaemonInstance

export const DomovoiDaemon: DomovoiDaemonConstructor = DomovoiDaemonImplementation
