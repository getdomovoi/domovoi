import { builtinModules } from "node:module"
import path from "node:path"

import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

import { vendorChunkFor } from "../../packages/ui/src/vite-chunks"

// Node builtins were externalized for us until vite 8 changed how a bundled
// require of a builtin resolves, which left the preload asking for
// child_process at runtime.
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "electron",
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { external: nodeBuiltins, output: { format: "cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      minify: "esbuild",
      reportCompressedSize: true,
      // electron-vite inferred this entry from the renderer root until vite 8
      // changed how a root without an explicit input is resolved.
      rollupOptions: {
        input: path.resolve(import.meta.dirname, "src/renderer/index.html"),
        output: { manualChunks: vendorChunkFor },
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
  },
})
