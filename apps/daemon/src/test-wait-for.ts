import { vi } from "vitest"

export function daemonWaitTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 10_000 : 3_000
}

// This bounds observation of async work, not the operation's own deadline.
// Busy CI workers can take more than Vitest's default second to observe I/O.
// Tests proving a latency bound must keep their explicit vi.waitFor timeout.
export function waitForDaemon<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: daemonWaitTimeoutMs(process.platform) })
}
