import { builtinModules } from "node:module"
import path from "node:path"

import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

import { vendorChunkFor } from "../../packages/ui/src/vite-chunks"
import { devLoopReporter } from "./src/dev/loop-reporter"

// Node builtins were externalized for us until vite 8 changed how a bundled
// require of a builtin resolves, which left the preload asking for
// child_process at runtime. Electron itself is supplied by the runtime the
// same way, so it belongs in the same list.
const runtimeProvided = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "electron",
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Measure the full entry, with no startup code hidden in another chunk.
    // Operator diagnostics are explicit strings, not inferred function names.
    build: { minify: "esbuild" },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: "esbuild",
      rollupOptions: { external: runtimeProvided, output: { format: "cjs" } },
    },
    esbuild: { keepNames: true },
  },
  renderer: {
    // A separately started local daemon admits the repository's fixed browser
    // development origin. Keep Desktop on that exact origin so real-daemon mode
    // preserves the daemon's WebSocket origin check.
    server: { port: 5178, strictPort: true },
    plugins: [
      react(),
      tailwindcss(),
      devLoopReporter({ root: path.resolve(import.meta.dirname, "../..") }),
    ],
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
        // Subpath first: an object alias matches by prefix in insertion order, so
        // the bare package alias below would otherwise turn this into
        // src/index.ts/relay-admission.
        "@getdomovoi/protocol/relay-admission": path.resolve(
          import.meta.dirname,
          "../../packages/protocol/relay-admission/index.ts",
        ),
        "@getdomovoi/protocol": path.resolve(
          import.meta.dirname,
          "../../packages/protocol/src/index.ts",
        ),
      },
    },
  },
})
