// Types for the reviewed bootstrap installer, so the daemon's update seam is
// checked against the function it calls instead of an untyped import.
export type BootstrapInstallOptions = {
  version: string
  baseUrl: string
  destination: string
  expectedSha256: string
  timeoutMs?: number
  inactivityTimeoutMs?: number
  cleanupTimeoutMs?: number
}

export type BootstrapInstallResult = {
  version: string
  path: string
  sha256: string
}

export function installBootstrapDaemon(options: BootstrapInstallOptions): Promise<BootstrapInstallResult>
