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
