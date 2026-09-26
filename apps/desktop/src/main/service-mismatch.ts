import type { DaemonServiceRuntimeReport } from "@getdomovoi/daemon"

import type { DesktopDaemonSeam } from "./desktop-daemon.js"

// Ruled 2026-09-23 (#577, A): an owner this app cannot talk to may be the
// login service on an older runtime. Only that refusal loads the check and
// its wording (service-mismatch-refusal.ts); every other answer passes
// through untouched.
export function withServiceMismatch(
  seam: DesktopDaemonSeam,
  readServiceRuntime: () => Promise<DaemonServiceRuntimeReport>,
): DesktopDaemonSeam {
  return async (options) => {
    const handle = await seam(options)
    if (handle.kind !== "refused" || handle.reason !== "owner-incompatible") return handle
    const { nameServiceMismatch } = await import("./service-mismatch-refusal.js")
    return nameServiceMismatch(handle, readServiceRuntime)
  }
}
