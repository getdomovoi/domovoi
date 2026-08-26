import path from "node:path"

import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
