import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const domTests = "src/**/*.dom.test.tsx"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}"],
      thresholds: { statements: 52, branches: 51, functions: 50, lines: 55 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          exclude: ["**/node_modules/**", "**/dist/**", domTests],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          include: [domTests],
        },
      },
    ],
  },
})
