import { defineConfig } from "vitest/config"

// Windows runners spawn Git and release file handles slowly enough that tests
// which pass everywhere else exceed the 5 second default and fail as flakes.
export function daemonTestScheduling(platform: NodeJS.Platform) {
  const windows = platform === "win32"
  return {
    // The 4-vCPU Windows runner also services Git, SQLite writers and sockets.
    // Leave room for that work instead of starting all three heaviest files.
    ...(windows ? { maxWorkers: 2 } : {}),
    testTimeout: windows ? 30_000 : 5_000,
    hookTimeout: windows ? 30_000 : 10_000,
  }
}

// Tests that start or attach a real local daemon hand acquireLocalDaemon a
// budget, and an expired budget is reported as a refusal, so a stalled runner
// turns a correct ownership into "expected 'refused' to be 'owned'" instead of
// a timeout. Measured across the 160 CI runs since local-daemon.test.ts landed,
// the heaviest of those tests costs a median of 717 ms on Windows, a 99th
// percentile of 4064 ms and a worst passing run of 5845 ms, and it failed twice
// at 4754 and 6900 ms against a fixed 3 second window. Two thirds of the
// runner's own test timeout clears that by a wide margin, leaves the remaining
// third for the rest of the test, stays under the 30 second budget the
// production daemon start uses for the same work, and still expires before
// Vitest gives up, so a genuine hang is refused with a reason rather than cut
// off by the runner.
export function localDaemonBudgetMs(platform: NodeJS.Platform): number {
  return Math.floor((daemonTestScheduling(platform).testTimeout * 2) / 3)
}

export default defineConfig({
  test: {
    ...daemonTestScheduling(process.platform),
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { statements: 84, branches: 77, functions: 86, lines: 87 },
    },
  },
})
