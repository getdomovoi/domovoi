import path from "node:path"

import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

import { vendorChunkFor } from "../../packages/ui/src/vite-chunks"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { output: { format: "cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      minify: "esbuild",
      reportCompressedSize: true,
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
  },
})
