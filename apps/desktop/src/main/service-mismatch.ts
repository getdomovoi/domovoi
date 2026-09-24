import type { DaemonServiceRuntimeReport } from "@getdomovoi/daemon"

import type { DesktopDaemonSeam } from "./desktop-daemon.js"

// Ruled 2026-09-23 (#577, A): an owner this app cannot talk to is, with a
// login service installed, that service on an older runtime. The refusal
// names the version the service's definition runs, or says it is older when
// the definition does not say. Anything else keeps the daemon's own words.
export function withServiceMismatch(
  seam: DesktopDaemonSeam,
  readServiceRuntime: () => Promise<DaemonServiceRuntimeReport>,
): DesktopDaemonSeam {
  return async (options) => {
    const handle = await seam(options)
    if (handle.kind !== "refused" || handle.reason !== "owner-incompatible") return handle
    let report: DaemonServiceRuntimeReport
    try {
      report = await readServiceRuntime()
    } catch {
      return handle
    }
    if (!report.installed) return handle
    const message = report.version === undefined
      ? "The login service runs an older Domovoi, which this app cannot talk to. Update the service to match this app."
      : `The login service runs Domovoi ${report.version}, which this app cannot talk to. Update the service to match this app.`
    return { ...handle, message }
  }
}
