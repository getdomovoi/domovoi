import { defineConfig } from "vitest/config"

// Windows runners spawn Git and release file handles slowly enough that tests
// which pass everywhere else exceed the 5 second default and fail as flakes.
const windows = process.platform === "win32"

export default defineConfig({
  test: {
    testTimeout: windows ? 30_000 : 5_000,
    hookTimeout: windows ? 30_000 : 10_000,
  },
})
