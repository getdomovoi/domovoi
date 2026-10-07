import { fileURLToPath } from "node:url"
import { defineConfig } from "tsup"
import { readSourceCommit } from "./source-commit.mjs"

export default defineConfig({
  define: {
    __BUILD_SOURCE_COMMIT__: JSON.stringify(readSourceCommit(fileURLToPath(new URL("../../", import.meta.url))) ?? null),
  },
  entry: {
    index: "src/index.ts",
    "daemon-command": "src/daemon-command.ts",
    public: "src/public.ts",
    "workspace-redaction": "src/workspace-redaction.ts",
    "machine-keyring-worker": "src/machine-keyring-worker.ts",
    "bootstrap-install": "src/bootstrap-install.ts",
  },
  format: ["esm"],
  platform: "node",
  noExternal: ["@getdomovoi/credential-store"],
  target: "node22",
  dts: true,
  clean: true,
  removeNodeProtocol: false,
})
