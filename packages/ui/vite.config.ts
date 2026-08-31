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
