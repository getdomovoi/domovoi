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

// A spawned fixture is a different class of wait from the one above. It boots
// Node with an import hook that transpiles the daemon source before the child
// creates a real daemon and listens, so it costs seconds where an in-process
// observation costs milliseconds. Measured across the 213 CI runs since the
// keyring responsiveness test landed, the whole of that test costs a median of
// 2826 ms on Windows against a 95th percentile of 4695 ms and a worst passing
// run of 8103 ms, while Ubuntu never passed 3596 ms and macOS 3551 ms, and
// startup is most of it. The same wait has expired twice, on Ubuntu at 3178 ms
// while it shared the observation budget above, and on Windows at 10151 ms once
// it had a fixed ten seconds. Twenty seconds is two and a half times the widest
// passing Windows run, and each caller keeps its own outer deadline, so a
// genuine hang is still bounded above this.
export function fixtureStartupTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 20_000 : 10_000
}

// An expiry here reads as "the fixture has not printed yet", which does not say
// whether the runner stalled or the child never intended to listen. Name the
// budget and keep the assertion underneath as the cause.
export function waitForFixtureStartup<T>(fixture: string, assertion: () => T | Promise<T>): Promise<T> {
  const timeout = fixtureStartupTimeoutMs(process.platform)
  return vi.waitFor(assertion, { timeout }).catch((cause: unknown) => {
    throw new Error(`${fixture} did not start within its ${timeout}ms startup budget`, { cause })
  })
}
