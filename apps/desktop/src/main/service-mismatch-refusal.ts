import type { DaemonServiceRuntimeReport, LocalDaemonHandle } from "@getdomovoi/daemon"

// Ruled 2026-09-23 (#577, A): an owner this app cannot talk to is, with a
// login service installed, that service on an older runtime. The refusal
// names the version the service's definition runs, or says it is older when
// the definition does not say. Anything else keeps the daemon's own words.
// Loaded only on that refusal (service-mismatch.ts), so none of it counts
// toward the startup bundle (owner ruling 2026-09-26, B).
export async function nameServiceMismatch(
  handle: Extract<LocalDaemonHandle, { kind: "refused" }>,
  readServiceRuntime: () => Promise<DaemonServiceRuntimeReport>,
): Promise<LocalDaemonHandle> {
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
