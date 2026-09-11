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
// it had a fixed ten seconds. Twenty seconds then expired twice on one Windows
// job (run 34616918057 and its rerun, 2026-09-11) on a docs-only commit whose
// parent had passed, while the four passing Windows runs that day cost 2458,
// 13013, 2730 and 2647 ms. Those observations do not say what crossed it;
// an intermittent fault in the fixture is still possible, so this budget is
// provisional. Twenty-five seconds is the most it can take without passing
// the production harness call budget below, which every Windows caller of
// that harness sizes its own test budget against, and the one caller of this
// wait keeps a wider outer deadline, so a genuine hang is still bounded.
export function fixtureStartupTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 25_000 : 10_000
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

// One call over the production fleet harness socket is a third class again. It
// reaches a real daemon that spawns Git, writes SQLite and dials a second
// daemon, so a single call carries whatever the runner charges for process
// creation that minute rather than the latency of the code under test. Measured
// across the 198 Windows jobs of the last 200 CI runs, the two tests that move
// a session cost, end to end, a median of 5705 ms and 4297 ms, a 95th
// percentile of 11122 ms and 8022 ms, and a worst passing run of 18354 ms and
// 13993 ms, while Ubuntu never passed 3253 ms and 2721 ms and never expired.
// Every passing run answered inside the fixed ten seconds it had, so ten
// seconds is the ceiling on the worst passing call. That same ten seconds
// expired three times in the window, on main at 11568 ms, on
// feat/add-skill-flow at 12951 ms and on this branch at 13757 ms, each of them
// "RPC test deadline: session.transfer", and seven runs slower than all three
// passed, so the split was where the runner's stall landed rather than any
// difference in behaviour. Twenty-five seconds clears that ceiling by two and a
// half, and every caller keeps a test budget above it, so a call that never
// answers is still bounded and still named.
export function productionRpcTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 25_000 : 10_000
}
