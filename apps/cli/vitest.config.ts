import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { statements: 64, branches: 46, functions: 80, lines: 68 },
    },
  },
})
