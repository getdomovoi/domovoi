import { createContext } from "react"

import type { DaemonServiceOutcome } from "./desktop-platform.js"

// Q351 A: desktop setup starts at "Keep Domovoi running after you quit". The
// desktop renderer provides the login service here, around the workspace, so
// setup can install it through the same bridge Settings uses. Absent on the
// web, in tests and on a desktop that ships no daemon runtime; setup then
// starts at the agents.
export type FirstRunService = {
  // Who holds the daemon. Setup offers the install only while this app does.
  owner: "app" | "other-app" | "outside" | undefined
  platform: "darwin" | "linux" | "win32"
  install: () => Promise<DaemonServiceOutcome>
  // The URL of the daemon this window reached. The service is installed with
  // the same environment as the app's own daemon (createServiceConfiguration),
  // and the window attaches to it after an install, so setup names this
  // address rather than the default one.
  endpoint?: string | undefined
}

export const FirstRunServiceContext = createContext<FirstRunService | undefined>(undefined)

// Whether a service read shows an install happened, in whole or in part.
function installedBy(service: { installed: boolean | null } | null): boolean {
  return service !== null && service.installed === true
}

// Whether an install outcome may have moved who holds the daemon, so the
// desktop must resolve its daemon again. The same rule as the shell's own
// service changes (serviceOutcomeMovesDaemon in workspace-shell.tsx): a
// success, a service installed but not attached, a failure that restarted or
// attached the daemon, or one that left the service installed. A failure that
// only stopped the app's daemon keeps the window, whose line says to reopen.
export function installMovesDaemon(outcome: DaemonServiceOutcome): boolean {
  if (outcome.ok || outcome.reason === "installed-not-attached") return true
  if (outcome.reason !== "failed") return false
  if (outcome.daemon === "restarted" || outcome.daemon === "attached") return true
  return installedBy(outcome.service)
}
