import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  removeNodeProtocol: false,
})
