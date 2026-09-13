import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", "relay/index": "relay/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
})
