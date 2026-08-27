import path from "node:path"

import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

import { vendorChunkFor } from "../../packages/ui/src/vite-chunks"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: { output: { manualChunks: vendorChunkFor } },
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
