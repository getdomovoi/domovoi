import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts", "relay/**/*.ts"],
      exclude: ["src/**/*.test.ts", "relay/testing/**"],
      thresholds: { statements: 97, branches: 91, functions: 98, lines: 97 },
    },
  },
})
