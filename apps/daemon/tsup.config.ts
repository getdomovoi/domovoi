import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    public: "src/public.ts",
    server: "src/internal.ts",
    "workspace-redaction": "src/workspace-redaction.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  removeNodeProtocol: false,
})
