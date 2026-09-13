import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", "relay/index": "relay/index.ts", "relay-admission/index": "relay-admission/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
})
