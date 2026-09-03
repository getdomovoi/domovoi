import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/public.ts", "src/server.ts", "src/workspace-redaction.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  removeNodeProtocol: false,
})
