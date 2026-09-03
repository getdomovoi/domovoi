import path from "node:path"

import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"

import { vendorChunkFor } from "../../packages/ui/src/vite-chunks"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: { output: { manualChunks: vendorChunkFor } },
  },
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../../packages/ui/src"),
      "@getdomovoi/protocol": path.resolve(
        import.meta.dirname,
        "../../packages/protocol/src/index.ts",
      ),
    },
  },
})
