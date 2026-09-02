import { defineConfig } from "vitest/config"

// Windows runners spawn Git and release file handles slowly enough that tests
// which pass everywhere else exceed the 5 second default and fail as flakes.
const windows = process.platform === "win32"

export default defineConfig({
  test: {
    testTimeout: windows ? 30_000 : 5_000,
    hookTimeout: windows ? 30_000 : 10_000,
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
